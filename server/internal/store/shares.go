package store

import (
	"context"
	"database/sql"
	"strings"
	"time"
)

// Statuses of batch result entries.
const (
	StatusShared      = "shared"
	StatusUnshared    = "unshared"
	StatusUnchanged   = "unchanged"
	StatusTransferred = "transferred"
	StatusLeft        = "left"
	StatusDeleted     = "deleted"
)

const warnUserDisabled = "user is disabled"

// CredentialBatch is a batch operation on the credentials named by IDs. It is
// all or nothing: when any entry fails, nothing changes and a *BatchError
// lists the failed entries. A dry run computes the same results and rolls
// back.
type CredentialBatch struct {
	Actor Actor
	// Admin lets the batch touch any user's credentials. Otherwise it reaches
	// only credentials the actor owns or, for operations that allow it, that
	// are shared with the actor; others are not_found.
	Admin  bool
	IDs    []string
	DryRun bool
	Now    time.Time
}

// CredentialBrief names a credential in batch results, as it was before the
// operation.
type CredentialBrief struct {
	ID       string
	RPID     string
	UserName string
	Owner    UserBrief
}

// Brief returns the credential's identification.
func (c Credential) Brief() CredentialBrief {
	return CredentialBrief{ID: c.ID, RPID: c.RPID, UserName: c.UserName, Owner: c.Owner}
}

// ShareResult is the outcome for one (credential, user) pair of a share or
// unshare batch.
type ShareResult struct {
	Credential CredentialBrief
	User       UserBrief
	Status     string
	Warnings   []string
}

// TransferResult is the outcome for one credential of a transfer batch.
type TransferResult struct {
	Credential CredentialBrief
	From, To   UserBrief
	Status     string
	KeepAccess bool
	Warnings   []string
}

// CredentialResult is the outcome for one credential of a leave or delete
// batch.
type CredentialResult struct {
	Credential CredentialBrief
	Status     string
	Warnings   []string
}

// reach is what a batch requires of each credential it names.
type reach int

const (
	// reachOwned: the actor owns it; one shared with the actor is forbidden.
	reachOwned reach = iota
	// reachShared: it is shared with the actor.
	reachShared
	// reachAccessible: the actor owns it or it is shared with them.
	reachAccessible
)

// credentials loads the credentials b.IDs names, one entry per ID. IDs that
// are repeated or out of reach are recorded in be and left nil.
func (b CredentialBatch) credentials(ctx context.Context, q queryer, r reach, be *BatchError) ([]*Credential, error) {
	out := make([]*Credential, len(b.IDs))
	seen := make(map[string]bool, len(b.IDs))
	for i, id := range b.IDs {
		if seen[id] {
			be.Add("ids", i, id, CodeInvalid, "duplicate item")
			continue
		}
		seen[id] = true
		var c Credential
		var err error
		if b.Admin {
			c, err = getAny(ctx, q, id)
		} else {
			c, err = getAccessible(ctx, q, b.Actor.ID, id)
		}
		if err == nil && !b.Admin {
			switch {
			case r == reachOwned && c.Access != AccessOwner:
				err = ErrForbidden
			case r == reachShared && c.Access != AccessShared:
				be.Add("ids", i, id, CodeNotFound, "credential is not shared with you")
				continue
			}
		}
		if err != nil {
			if err := be.AddErr("ids", i, id, err, "credential not found"); err != nil {
				return nil, err
			}
			continue
		}
		out[i] = &c
	}
	return out, nil
}

// refValue is a user reference as the client sent it, for error entries.
func refValue(k UserKey) any {
	if k.ID != 0 {
		return k.ID
	}
	return k.Username
}

// resolveUsers loads the users keys refers to, one entry per key. Unknown and
// repeated users are recorded in be under field and left nil.
func resolveUsers(ctx context.Context, q queryer, field string, keys []UserKey, be *BatchError) ([]*User, error) {
	out := make([]*User, len(keys))
	seen := make(map[int64]bool, len(keys))
	for i, k := range keys {
		u, err := resolveUser(ctx, q, k)
		if err != nil {
			if err := be.AddErr(field, i, refValue(k), err, "user not found"); err != nil {
				return nil, err
			}
			continue
		}
		if seen[u.ID] {
			be.Add(field, i, refValue(k), CodeInvalid, "duplicate item")
			continue
		}
		seen[u.ID] = true
		out[i] = &u
	}
	return out, nil
}

func userWarnings(u *User) []string {
	if u.Disabled {
		return []string{warnUserDisabled}
	}
	return []string{}
}

// actorRef is the actor as a nullable users(id) reference.
func actorRef(a Actor) sql.NullInt64 { return sql.NullInt64{Int64: a.ID, Valid: a.ID != 0} }

// removeShare deletes the share of c with user and records action; it reports
// false when there was no such share.
func removeShare(ctx context.Context, q queryer, actor Actor, c Credential, user UserBrief, action string, now time.Time) (bool, error) {
	res, err := q.ExecContext(ctx, `DELETE FROM credential_shares WHERE credential_seq = ? AND user_id = ?`, c.seq, user.ID)
	if err != nil {
		return false, err
	}
	if n, err := res.RowsAffected(); err != nil || n == 0 {
		return false, err
	}
	return true, writeAudit(ctx, q, now, actor, AuditEntry{Action: action, Subject: &c.Owner, Target: &user, Credential: c.audit()})
}

// ShareCredentials shares the credentials with the users: one result per
// (credential, user) pair, in request order.
func (s *Store) ShareCredentials(ctx context.Context, b CredentialBatch, users []UserKey) ([]ShareResult, error) {
	results := []ShareResult{}
	err := s.inTx(ctx, b.DryRun, func(tx *sql.Tx) error {
		be := &BatchError{}
		creds, err := b.credentials(ctx, tx, reachOwned, be)
		if err != nil {
			return err
		}
		recipients, err := resolveUsers(ctx, tx, "users", users, be)
		if err != nil {
			return err
		}
		ownerReported := map[int]bool{}
		for _, c := range creds {
			if c == nil {
				continue
			}
			for j, u := range recipients {
				if u == nil {
					continue
				}
				if u.ID == c.Owner.ID {
					if !ownerReported[j] {
						be.Add("users", j, refValue(users[j]), CodeInvalid, "user owns this credential")
						ownerReported[j] = true
					}
					continue
				}
				res, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO credential_shares
					(credential_seq, user_id, shared_by, created_at) VALUES (?, ?, ?, ?)`,
					c.seq, u.ID, actorRef(b.Actor), toMillis(b.Now))
				if err != nil {
					return err
				}
				n, err := res.RowsAffected()
				if err != nil {
					return err
				}
				status := StatusUnchanged
				target := u.Brief()
				if n > 0 {
					status = StatusShared
					if err := writeAudit(ctx, tx, b.Now, b.Actor, AuditEntry{Action: "credential.share",
						Subject: &c.Owner, Target: &target, Credential: c.audit()}); err != nil {
						return err
					}
				}
				results = append(results, ShareResult{Credential: c.Brief(), User: target, Status: status, Warnings: userWarnings(u)})
			}
		}
		return be.Err()
	})
	if err != nil {
		return nil, err
	}
	return results, nil
}

// UnshareCredentials removes the credentials' shares with the users, or with
// everyone when all is set (users is then ignored): one result per pair, or
// with all, per existing share.
func (s *Store) UnshareCredentials(ctx context.Context, b CredentialBatch, users []UserKey, all bool) ([]ShareResult, error) {
	results := []ShareResult{}
	err := s.inTx(ctx, b.DryRun, func(tx *sql.Tx) error {
		be := &BatchError{}
		creds, err := b.credentials(ctx, tx, reachOwned, be)
		if err != nil {
			return err
		}
		var targets []UserBrief
		if !all {
			resolved, err := resolveUsers(ctx, tx, "users", users, be)
			if err != nil {
				return err
			}
			for _, u := range resolved {
				if u != nil {
					targets = append(targets, u.Brief())
				}
			}
		}
		for _, c := range creds {
			if c == nil {
				continue
			}
			if all {
				if targets, err = queryRows(ctx, tx, func(r rowScanner) (UserBrief, error) {
					var u UserBrief
					return u, r.Scan(&u.ID, &u.Username)
				}, `SELECT u.id, u.username FROM credential_shares s JOIN users u ON u.id = s.user_id
					WHERE s.credential_seq = ? ORDER BY s.created_at, s.rowid`, c.seq); err != nil {
					return err
				}
			}
			for _, u := range targets {
				removed, err := removeShare(ctx, tx, b.Actor, *c, u, "credential.unshare", b.Now)
				if err != nil {
					return err
				}
				status := StatusUnchanged
				if removed {
					status = StatusUnshared
				}
				results = append(results, ShareResult{Credential: c.Brief(), User: u, Status: status, Warnings: []string{}})
			}
		}
		return be.Err()
	})
	if err != nil {
		return nil, err
	}
	return results, nil
}

// TransferCredentials makes to the owner of the credentials. Shares with other
// users stay; a share with to is dropped, and with keepAccess the previous
// owner keeps a share (shared by the actor). Transfers to the current owner
// are unchanged.
func (s *Store) TransferCredentials(ctx context.Context, b CredentialBatch, to UserKey, keepAccess bool) ([]TransferResult, error) {
	results := []TransferResult{}
	err := s.inTx(ctx, b.DryRun, func(tx *sql.Tx) error {
		be := &BatchError{}
		creds, err := b.credentials(ctx, tx, reachOwned, be)
		if err != nil {
			return err
		}
		target, err := resolveUser(ctx, tx, to)
		if err != nil {
			if err := be.AddErr("to", 0, refValue(to), err, "user not found"); err != nil {
				return err
			}
			return be.Err()
		}
		toBrief := target.Brief()
		for _, c := range creds {
			if c == nil {
				continue
			}
			r := TransferResult{Credential: c.Brief(), From: c.Owner, To: toBrief, Status: StatusUnchanged,
				KeepAccess: keepAccess, Warnings: userWarnings(&target)}
			if c.Owner.ID != target.ID {
				dup, err := transferCredential(ctx, tx, b.Actor, *c, toBrief, keepAccess, b.Now)
				if err != nil {
					return err
				}
				if dup {
					r.Warnings = append(r.Warnings, target.Username+" already has a passkey for this account")
				}
				r.Status = StatusTransferred
			}
			results = append(results, r)
		}
		return be.Err()
	})
	if err != nil {
		return nil, err
	}
	return results, nil
}

// transferCredential makes to the owner of c (see TransferCredentials). It
// reports whether to already owned another credential for the same account
// (rp_id case-insensitive and user_handle); both are kept.
func transferCredential(ctx context.Context, q queryer, actor Actor, c Credential, to UserBrief, keepAccess bool, now time.Time) (dup bool, err error) {
	if err := q.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM credentials
		WHERE user_id = ? AND rp_id_key = ? AND user_handle = ? AND seq != ?)`,
		to.ID, strings.ToLower(c.RPID), c.UserHandle, c.seq).Scan(&dup); err != nil {
		return false, err
	}
	if _, err := q.ExecContext(ctx, `UPDATE credentials SET user_id = ? WHERE seq = ?`, to.ID, c.seq); err != nil {
		return false, err
	}
	if _, err := q.ExecContext(ctx, `DELETE FROM credential_shares WHERE credential_seq = ? AND user_id = ?`, c.seq, to.ID); err != nil {
		return false, err
	}
	if keepAccess {
		if _, err := q.ExecContext(ctx, `INSERT INTO credential_shares (credential_seq, user_id, shared_by, created_at)
			VALUES (?, ?, ?, ?)`, c.seq, c.Owner.ID, actorRef(actor), toMillis(now)); err != nil {
			return false, err
		}
	}
	return dup, writeAudit(ctx, q, now, actor, AuditEntry{Action: "credential.transfer",
		Subject: &c.Owner, Target: &to, Credential: c.audit(), Detail: map[string]any{"keep_access": keepAccess}})
}

// LeaveCredentials removes the actor's shares of the credentials; IDs that
// are not shared with the actor are not_found. b.Admin is ignored.
func (s *Store) LeaveCredentials(ctx context.Context, b CredentialBatch) ([]CredentialResult, error) {
	b.Admin = false
	return s.removeCredentials(ctx, b, reachShared)
}

// DeleteCredentials deletes the credentials the actor owns and leaves those
// shared with them, like DeleteCredential; with b.Admin it deletes any.
func (s *Store) DeleteCredentials(ctx context.Context, b CredentialBatch) ([]CredentialResult, error) {
	return s.removeCredentials(ctx, b, reachAccessible)
}

func (s *Store) removeCredentials(ctx context.Context, b CredentialBatch, r reach) ([]CredentialResult, error) {
	results := []CredentialResult{}
	err := s.inTx(ctx, b.DryRun, func(tx *sql.Tx) error {
		be := &BatchError{}
		creds, err := b.credentials(ctx, tx, r, be)
		if err != nil {
			return err
		}
		for _, c := range creds {
			if c == nil {
				continue
			}
			status := StatusDeleted
			if b.Admin {
				err = deleteCredential(ctx, tx, b.Actor, *c, b.Now)
			} else {
				status, err = removeAccess(ctx, tx, b.Actor, *c, b.Actor.ID, b.Now)
			}
			if err != nil {
				return err
			}
			results = append(results, CredentialResult{Credential: c.Brief(), Status: status, Warnings: []string{}})
		}
		return be.Err()
	})
	if err != nil {
		return nil, err
	}
	return results, nil
}
