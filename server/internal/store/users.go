package store

import (
	"context"
	"database/sql"
	"errors"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"
)

// NewUser is an account to create.
type NewUser struct {
	Username string
	Password string
	IsAdmin  bool
	Note     string
}

// UserUpdate changes a user; nil fields are left as they are.
type UserUpdate struct {
	Username *string
	Password *string
	IsAdmin  *bool
	Disabled *bool
	Note     *string
}

// UserEdit is one entry of UpdateUsers.
type UserEdit struct {
	User UserKey
	UserUpdate
}

// UpdatedUser is a user after an update and the fields that changed, in the
// order username, password, is_admin, disabled, note.
type UpdatedUser struct {
	User    User
	Changes []string
}

// DeletedUser reports a deleted user: how many of its credentials were deleted
// with it and how many were handed over first.
type DeletedUser struct {
	User        UserBrief
	Deleted     int
	Transferred int
}

var (
	errInvalidUsername = Invalid("username must be 1-%d characters", MaxUsernameLen)
	errEmptyPassword   = Invalid("password must not be empty")
	errLongPassword    = Invalid("password must be at most %d bytes", maxPasswordBytes)
	// errTokenOwnPassword keeps an API token from renewing itself by changing
	// its user's password through the administrator endpoints.
	errTokenOwnPassword = Invalid("an API token cannot change the password of its own user")
	errReservedUsername = Invalid("this username belongs to the bootstrap administrator (PKB_ADMIN_USERNAME) and cannot be given or taken away")
	errDuplicate        = Invalid("duplicate item")
	errDemoteSelf       = Invalid("you cannot remove your own administrator role")
	errDisableSelf      = Invalid("you cannot disable yourself")
	errDeleteSelf       = Invalid("you cannot delete yourself")
	errUsernameTaken    = &conflictError{"username already exists"}
)

// maxPasswordBytes is the longest password bcrypt accepts.
const maxPasswordBytes = 72

// value is the key as the client sent it, for batch error items.
func (k UserKey) value() any {
	if k.ID != 0 {
		return k.ID
	}
	return k.Username
}

// withPasswords runs fn with the bcrypt hashes of passwords ("" stays "").
// Hashing is slow and the database has a single connection, so it never
// happens inside a transaction: fn first runs with empty hashes in a
// transaction that is rolled back, which rejects an invalid request before
// any hashing and is all a dry run does, and then once more with the hashes
// in the transaction that commits.
func (s *Store) withPasswords(ctx context.Context, dryRun bool, passwords []string, fn func(tx *sql.Tx, hashes []string) error) error {
	hashes := make([]string, len(passwords))
	run := func(dryRun bool) error {
		return s.inTx(ctx, dryRun, func(tx *sql.Tx) error { return fn(tx, hashes) })
	}
	if dryRun || !slices.ContainsFunc(passwords, func(p string) bool { return p != "" }) {
		return run(dryRun)
	}
	if err := run(true); err != nil {
		return err
	}
	// A batch can hold hundreds of passwords; hash them on all CPUs.
	var wg sync.WaitGroup
	errs := make([]error, len(passwords))
	slots := make(chan struct{}, runtime.GOMAXPROCS(0))
	for i, p := range passwords {
		if p == "" {
			continue
		}
		wg.Go(func() {
			slots <- struct{}{}
			defer func() { <-slots }()
			hashes[i], errs[i] = s.hash(p)
		})
	}
	wg.Wait()
	if err := errors.Join(errs...); err != nil {
		return err
	}
	return run(false)
}

// usernameTaken returns errUsernameTaken, an ErrConflict, when a user other
// than except has the username key.
func usernameTaken(ctx context.Context, q queryer, key string, except int64) error {
	var id int64
	err := q.QueryRowContext(ctx, `SELECT id FROM users WHERE username_key = ? AND id != ?`, key, except).Scan(&id)
	switch {
	case err == nil:
		return errUsernameTaken
	case errors.Is(err, sql.ErrNoRows):
		return nil
	default:
		return err
	}
}

// insertUser adds u with the password hash and records user.create.
func insertUser(ctx context.Context, q queryer, actor Actor, u NewUser, hash string, now time.Time) (User, error) {
	display, key, ok := NormalizeUsername(u.Username)
	if !ok {
		return User{}, errInvalidUsername
	}
	if u.Password == "" {
		return User{}, errEmptyPassword
	}
	if len(u.Password) > maxPasswordBytes {
		return User{}, errLongPassword
	}
	if err := usernameTaken(ctx, q, key, 0); err != nil {
		return User{}, err
	}
	res, err := q.ExecContext(ctx,
		`INSERT INTO users (username, username_key, password_hash, is_admin, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		display, key, hash, u.IsAdmin, u.Note, toMillis(now))
	if err != nil {
		return User{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return User{}, err
	}
	user, err := resolveUser(ctx, q, UserKey{ID: id})
	if err != nil {
		return User{}, err
	}
	subject := user.Brief()
	return user, writeAudit(ctx, q, now, actor, AuditEntry{Action: "user.create", Subject: &subject,
		Detail: map[string]any{"is_admin": u.IsAdmin}})
}

type fromTo struct {
	From any `json:"from"`
	To   any `json:"to"`
}

// updateUser applies u to user and, when anything changed, records
// user.update. hash is the new password hash when u.Password is set.
// reserved is the lookup key of the bootstrap administrator's name, or "".
func updateUser(ctx context.Context, q queryer, actor Actor, user User, u UserUpdate, hash, reserved string, now time.Time) (UpdatedUser, error) {
	self := actor.ID == user.ID
	switch {
	case u.IsAdmin != nil && !*u.IsAdmin && self:
		return UpdatedUser{}, errDemoteSelf
	case u.Disabled != nil && *u.Disabled && self:
		return UpdatedUser{}, errDisableSelf
	case u.Password != nil && *u.Password == "":
		return UpdatedUser{}, errEmptyPassword
	case u.Password != nil && len(*u.Password) > maxPasswordBytes:
		return UpdatedUser{}, errLongPassword
	case u.Password != nil && self && strings.HasPrefix(actor.Via, "token:"):
		return UpdatedUser{}, errTokenOwnPassword
	}
	var (
		names   = []string{}
		changes = map[string]any{}
		sets    []string
		args    []any
	)
	assign := func(column string, value any) {
		sets = append(sets, column+" = ?")
		args = append(args, value)
	}
	changed := func(name string, from, to any) {
		names = append(names, name)
		changes[name] = fromTo{from, to}
		assign(name, to)
	}
	if u.Username != nil {
		display, key, ok := NormalizeUsername(*u.Username)
		if !ok {
			return UpdatedUser{}, errInvalidUsername
		}
		if display != user.Username {
			if oldKey := strings.ToLower(user.Username); reserved != "" && key != oldKey && (key == reserved || oldKey == reserved) {
				return UpdatedUser{}, errReservedUsername
			}
			if err := usernameTaken(ctx, q, key, user.ID); err != nil {
				return UpdatedUser{}, err
			}
			changed("username", user.Username, display)
			assign("username_key", key)
		}
	}
	if u.Password != nil {
		names = append(names, "password")
		changes["password"] = true
		assign("password_hash", hash)
	}
	if u.IsAdmin != nil && *u.IsAdmin != user.IsAdmin {
		changed("is_admin", user.IsAdmin, *u.IsAdmin)
	}
	if u.Disabled != nil && *u.Disabled != user.Disabled {
		changed("disabled", user.Disabled, *u.Disabled)
	}
	if u.Note != nil && *u.Note != user.Note {
		changed("note", user.Note, *u.Note)
	}
	if len(names) == 0 {
		return UpdatedUser{User: user, Changes: names}, nil
	}
	if _, err := q.ExecContext(ctx, `UPDATE users SET `+strings.Join(sets, ", ")+` WHERE id = ?`, append(args, user.ID)...); err != nil {
		return UpdatedUser{}, err
	}
	updated, err := resolveUser(ctx, q, UserKey{ID: user.ID})
	if err != nil {
		return UpdatedUser{}, err
	}
	// The subject is the user as it was named before the change.
	subject := user.Brief()
	return UpdatedUser{User: updated, Changes: names}, writeAudit(ctx, q, now, actor, AuditEntry{
		Action: "user.update", Subject: &subject, Detail: map[string]any{"changes": changes}})
}

// deleteUser removes user and records user.delete. With a recipient, the
// user's credentials are first transferred to it (one credential.transfer
// each): their other shares stay, and the recipient's own shares of them are
// removed.
func deleteUser(ctx context.Context, q queryer, actor Actor, user User, recipient *User, now time.Time) (DeletedUser, error) {
	if actor.ID == user.ID {
		return DeletedUser{}, errDeleteSelf
	}
	subject := user.Brief()
	out := DeletedUser{User: subject}
	var target *UserBrief
	if recipient != nil {
		b := recipient.Brief()
		target = &b
		creds, err := queryRows(ctx, q, func(r rowScanner) (Credential, error) { return scanCredential(r) },
			`SELECT `+credentialColumns+credentialsFrom+` WHERE c.user_id = ? ORDER BY c.seq`, user.ID)
		if err != nil {
			return DeletedUser{}, err
		}
		for _, c := range creds {
			if _, err := transferCredential(ctx, q, actor, c, b, false, now); err != nil {
				return DeletedUser{}, err
			}
		}
		out.Transferred = len(creds)
	}
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM credentials WHERE user_id = ?`, user.ID).Scan(&out.Deleted); err != nil {
		return DeletedUser{}, err
	}
	if _, err := q.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, user.ID); err != nil {
		return DeletedUser{}, err
	}
	return out, writeAudit(ctx, q, now, actor, AuditEntry{Action: "user.delete", Subject: &subject, Target: target,
		Detail: map[string]any{"credentials_deleted": out.Deleted, "credentials_transferred": out.Transferred}})
}

// CreateUserAs creates an account on behalf of actor and records user.create.
// An invalid username or an empty password is an *InvalidError, a taken
// username (case-insensitive) ErrConflict.
func (s *Store) CreateUserAs(ctx context.Context, actor Actor, u NewUser, now time.Time) (User, error) {
	var user User
	err := s.withPasswords(ctx, false, []string{u.Password}, func(tx *sql.Tx, hashes []string) (err error) {
		user, err = insertUser(ctx, tx, actor, u, hashes[0], now)
		return err
	})
	return user, err
}

// UpdateUser changes the user on behalf of actor and records user.update with
// the fields that changed. Administrators cannot remove their own role or
// disable themselves (*InvalidError); a taken username is ErrConflict.
// Renaming changes the name HTTP Basic sign-in needs.
func (s *Store) UpdateUser(ctx context.Context, actor Actor, id int64, u UserUpdate, now time.Time) (UpdatedUser, error) {
	var out UpdatedUser
	err := s.withPasswords(ctx, false, []string{deref(u.Password)}, func(tx *sql.Tx, hashes []string) error {
		user, err := resolveUser(ctx, tx, UserKey{ID: id})
		if err != nil {
			return err
		}
		out, err = updateUser(ctx, tx, actor, user, u, hashes[0], s.reservedKey, now)
		return err
	})
	return out, err
}

// DeleteUser removes the user with its credentials, the shares it received,
// its sessions and its tokens, and records user.delete. Actors cannot delete
// themselves (*InvalidError).
func (s *Store) DeleteUser(ctx context.Context, actor Actor, id int64, now time.Time) error {
	return s.inTx(ctx, false, func(tx *sql.Tx) error {
		user, err := resolveUser(ctx, tx, UserKey{ID: id})
		if err != nil {
			return err
		}
		_, err = deleteUser(ctx, tx, actor, user, nil, now)
		return err
	})
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// CreateUsers creates the users all or nothing, like CreateUserAs. Failed
// entries are reported in a *BatchError under field "users" with the username
// as value; a username used twice in the batch is a conflict. A dry run hashes
// no passwords and returns users with temporary IDs.
func (s *Store) CreateUsers(ctx context.Context, actor Actor, users []NewUser, dryRun bool, now time.Time) ([]User, error) {
	passwords := make([]string, len(users))
	for i, u := range users {
		passwords[i] = u.Password
	}
	var out []User
	err := s.withPasswords(ctx, dryRun, passwords, func(tx *sql.Tx, hashes []string) error {
		out = make([]User, 0, len(users))
		var be BatchError
		for i, u := range users {
			user, err := insertUser(ctx, tx, actor, u, hashes[i], now)
			if err != nil {
				if err := be.AddErr("users", i, u.Username, err, "user not found"); err != nil {
					return err
				}
				continue
			}
			out = append(out, user)
		}
		return be.Err()
	})
	return out, err
}

// UpdateUsers applies the edits all or nothing, like UpdateUser. Failed
// entries are reported in a *BatchError under field "items" with the user
// reference as value; a user edited twice is a duplicate item. A dry run
// hashes no passwords.
func (s *Store) UpdateUsers(ctx context.Context, actor Actor, edits []UserEdit, dryRun bool, now time.Time) ([]UpdatedUser, error) {
	passwords := make([]string, len(edits))
	for i, e := range edits {
		passwords[i] = deref(e.Password)
	}
	var out []UpdatedUser
	err := s.withPasswords(ctx, dryRun, passwords, func(tx *sql.Tx, hashes []string) error {
		out = make([]UpdatedUser, 0, len(edits))
		var be BatchError
		seen := map[int64]bool{}
		for i, e := range edits {
			user, err := resolveUser(ctx, tx, e.User)
			if err == nil && seen[user.ID] {
				err = errDuplicate
			}
			var res UpdatedUser
			if err == nil {
				seen[user.ID] = true
				res, err = updateUser(ctx, tx, actor, user, e.UserUpdate, hashes[i], s.reservedKey, now)
			}
			if err != nil {
				if err := be.AddErr("items", i, e.User.value(), err, "user not found"); err != nil {
					return err
				}
				continue
			}
			out = append(out, res)
		}
		return be.Err()
	})
	return out, err
}

// DeleteUsers deletes the users all or nothing, like DeleteUser. With a
// recipient, each user's credentials are transferred to it first (see
// deleteUser). Failed entries are reported in a *BatchError under field
// "users", or "transfer_credentials_to" for a recipient that is missing,
// disabled or being deleted.
func (s *Store) DeleteUsers(ctx context.Context, actor Actor, keys []UserKey, recipient *UserKey, dryRun bool, now time.Time) ([]DeletedUser, error) {
	var out []DeletedUser
	err := s.inTx(ctx, dryRun, func(tx *sql.Tx) error {
		var be BatchError
		users := make([]User, 0, len(keys))
		deleting := map[int64]bool{}
		for i, k := range keys {
			user, err := resolveUser(ctx, tx, k)
			switch {
			case err != nil:
			case deleting[user.ID]:
				err = errDuplicate
			case user.ID == actor.ID:
				err = errDeleteSelf
			}
			if err != nil {
				if err := be.AddErr("users", i, k.value(), err, "user not found"); err != nil {
					return err
				}
				continue
			}
			deleting[user.ID] = true
			users = append(users, user)
		}
		var to *User
		if recipient != nil {
			user, err := resolveUser(ctx, tx, *recipient)
			switch {
			case err != nil:
			case deleting[user.ID]:
				err = Invalid("the recipient is being deleted")
			case user.Disabled:
				err = Invalid(warnUserDisabled)
			}
			if err != nil {
				if err := be.AddErr("transfer_credentials_to", 0, recipient.value(), err, "user not found"); err != nil {
					return err
				}
			} else {
				to = &user
			}
		}
		if err := be.Err(); err != nil {
			return err
		}
		out = make([]DeletedUser, 0, len(users))
		for _, u := range users {
			d, err := deleteUser(ctx, tx, actor, u, to, now)
			if err != nil {
				return err
			}
			out = append(out, d)
		}
		return nil
	})
	return out, err
}

// Directory returns every active user, ordered by username ignoring case.
func (s *Store) Directory(ctx context.Context) ([]UserBrief, error) {
	return queryRows(ctx, s.db, scanUserBrief, `SELECT id, username FROM users WHERE disabled = 0 ORDER BY username_key`)
}

// Overview summarises users, credentials and sites for the administrators.
type Overview struct {
	Users       UserStats
	Credentials CredentialStats
	// Sites are the sites with the most credentials, at most 20.
	Sites []SiteStats
}

// UserStats counts users.
type UserStats struct {
	Total, Admins, Disabled int
}

// CredentialStats counts credentials: Shared those shared with at least one
// user, Shares the share rows and Sites the distinct rp_ids (ignoring case).
type CredentialStats struct {
	Total, Shared, Shares, Sites int
}

// SiteStats counts the credentials of one rp_id (lower-cased) and the users
// owning them.
type SiteStats struct {
	RPID        string
	Credentials int
	Owners      int
}

const maxOverviewSites = 20

// Overview returns the statistics of the administrators' overview page.
func (s *Store) Overview(ctx context.Context) (Overview, error) {
	var o Overview
	err := s.db.QueryRowContext(ctx, `SELECT
		(SELECT COUNT(*) FROM users),
		(SELECT COUNT(*) FROM users WHERE is_admin != 0),
		(SELECT COUNT(*) FROM users WHERE disabled != 0),
		(SELECT COUNT(*) FROM credentials),
		(SELECT COUNT(DISTINCT credential_seq) FROM credential_shares),
		(SELECT COUNT(*) FROM credential_shares),
		(SELECT COUNT(DISTINCT rp_id_key) FROM credentials)`).Scan(
		&o.Users.Total, &o.Users.Admins, &o.Users.Disabled,
		&o.Credentials.Total, &o.Credentials.Shared, &o.Credentials.Shares, &o.Credentials.Sites)
	if err != nil {
		return Overview{}, err
	}
	o.Sites, err = queryRows(ctx, s.db, func(r rowScanner) (SiteStats, error) {
		var st SiteStats
		return st, r.Scan(&st.RPID, &st.Credentials, &st.Owners)
	}, `SELECT rp_id_key, COUNT(*), COUNT(DISTINCT user_id) FROM credentials
		GROUP BY rp_id_key ORDER BY COUNT(*) DESC, rp_id_key LIMIT ?`, maxOverviewSites)
	return o, err
}
