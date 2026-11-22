package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// How a user reaches a credential (Credential.Access, AccessFilter.Access).
const (
	AccessOwner  = "owner"
	AccessShared = "shared"
)

// Credential is a stored passkey.
type Credential struct {
	ID              string
	RPID            string
	RPName          string
	UserHandle      string
	UserName        string
	UserDisplayName string
	Alg             int
	PrivateKey      string
	PublicKey       string
	SignCount       int64
	Label           string
	// Fields are the custom fields, never nil.
	Fields     []Field
	Origin     string
	CreatedAt  time.Time
	LastUsedAt *time.Time
	UseCount   int64

	Owner UserBrief
	// Access is how the user the credential was loaded for reaches it,
	// AccessOwner or AccessShared; SharedAt is when it was shared with them.
	// Both are empty for credentials loaded without a user (administrators).
	Access   string
	SharedAt *time.Time
	// Shares lists the users the credential is shared with, oldest first.
	Shares []Share

	seq int64
	// edited lists the name columns the user changed (see nameColumns),
	// comma-separated in that order.
	edited string
}

// nameColumns are the credential's names a user can edit. They are only
// shown, never signed.
var nameColumns = []string{"rp_name", "user_name", "user_display_name"}

// names points at the values of nameColumns.
func (c *Credential) names() []*string { return []*string{&c.RPName, &c.UserName, &c.UserDisplayName} }

// isEdited reports whether the user changed the name column.
func (c *Credential) isEdited(column string) bool {
	return slices.Contains(strings.Split(c.edited, ","), column)
}

// markEdited adds columns to the edited name columns.
func (c *Credential) markEdited(columns ...string) {
	var out []string
	for _, col := range nameColumns {
		if c.isEdited(col) || slices.Contains(columns, col) {
			out = append(out, col)
		}
	}
	c.edited = strings.Join(out, ",")
}

// Share is a credential shared with a user.
type Share struct {
	User     UserBrief
	SharedAt time.Time
	// SharedBy is who shared it (possibly an administrator), nil once that
	// user is deleted.
	SharedBy *UserBrief
	// LastUsedAt is the user's latest use of the credential.
	LastUsedAt *time.Time
}

// credentialColumns are the columns scanCredential reads from credentials c
// joined with their owner o (credentialsFrom).
const credentialColumns = `c.seq, c.user_id, o.username, c.id, c.rp_id, c.rp_name, c.user_handle, c.user_name,
	c.user_display_name, c.alg, c.private_key, c.public_key, c.sign_count, c.label, c.origin, c.created_at,
	c.last_used_at, c.use_count, c.fields, c.edited`

const credentialsFrom = ` FROM credentials c JOIN users o ON o.id = c.user_id`

// accessibleFrom selects credentials with the time they were shared with a
// user, its first parameter (scanAccessible).
const accessibleFrom = `SELECT ` + credentialColumns + `, sh.created_at` + credentialsFrom + `
	LEFT JOIN credential_shares sh ON sh.credential_seq = c.seq AND sh.user_id = ?`

// accessibleQuery selects the credentials a user owns or that are shared with
// them. Its parameters are the user's ID three times. The IN list keeps both
// lookups on indexes.
const accessibleQuery = accessibleFrom + `
	WHERE c.seq IN (SELECT seq FROM credentials WHERE user_id = ?
		UNION ALL SELECT credential_seq FROM credential_shares WHERE user_id = ?)`

const credentialOrder = ` ORDER BY c.created_at DESC, c.seq DESC`

// scanCredential scans credentialColumns followed by trailing.
func scanCredential(r rowScanner, trailing ...any) (Credential, error) {
	var (
		c        Credential
		created  int64
		lastUsed sql.NullInt64
		fields   string
	)
	dest := append([]any{&c.seq, &c.Owner.ID, &c.Owner.Username, &c.ID, &c.RPID, &c.RPName, &c.UserHandle,
		&c.UserName, &c.UserDisplayName, &c.Alg, &c.PrivateKey, &c.PublicKey, &c.SignCount, &c.Label, &c.Origin,
		&created, &lastUsed, &c.UseCount, &fields, &c.edited}, trailing...)
	if err := r.Scan(dest...); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Credential{}, ErrNotFound
		}
		return Credential{}, err
	}
	c.CreatedAt = fromMillis(created)
	c.LastUsedAt = fromNullMillis(lastUsed)
	if err := json.Unmarshal([]byte(fields), &c.Fields); err != nil {
		return Credential{}, fmt.Errorf("fields of credential %s: %w", c.ID, err)
	}
	if c.Fields == nil {
		c.Fields = []Field{}
	}
	return c, nil
}

// scanAccessible returns a scanner for accessibleFrom rows that sets Access
// and SharedAt relative to the user.
func scanAccessible(userID int64) func(rowScanner) (Credential, error) {
	return func(r rowScanner) (Credential, error) {
		var sharedAt sql.NullInt64
		c, err := scanCredential(r, &sharedAt)
		if err != nil {
			return Credential{}, err
		}
		c.Access = AccessOwner
		if c.Owner.ID != userID {
			c.Access = AccessShared
			c.SharedAt = fromNullMillis(sharedAt)
		}
		return c, nil
	}
}

// getAccessible loads a credential the user owns or that is shared with them.
// It looks the ID up directly instead of listing all of the user's
// credentials like accessibleQuery.
func getAccessible(ctx context.Context, q queryer, userID int64, id string) (Credential, error) {
	return scanAccessible(userID)(q.QueryRowContext(ctx, accessibleFrom+`
		WHERE c.id = ? AND (c.user_id = ? OR sh.user_id IS NOT NULL)`, userID, id, userID))
}

// getAny loads any credential.
func getAny(ctx context.Context, q queryer, id string) (Credential, error) {
	return scanCredential(q.QueryRowContext(ctx, `SELECT `+credentialColumns+credentialsFrom+` WHERE c.id = ?`, id))
}

// loadShares fills the Shares of creds.
func loadShares(ctx context.Context, q queryer, creds []Credential) error {
	if len(creds) == 0 {
		return nil
	}
	index := make(map[int64]int, len(creds))
	seqs := make([]int64, len(creds))
	for i, c := range creds {
		index[c.seq] = i
		seqs[i] = c.seq
	}
	list, err := json.Marshal(seqs)
	if err != nil {
		return err
	}
	type seqShare struct {
		seq   int64
		share Share
	}
	shares, err := queryRows(ctx, q, func(r rowScanner) (seqShare, error) {
		var (
			s        seqShare
			created  int64
			byID     sql.NullInt64
			byName   sql.NullString
			lastUsed sql.NullInt64
		)
		if err := r.Scan(&s.seq, &s.share.User.ID, &s.share.User.Username, &created, &byID, &byName, &lastUsed); err != nil {
			return seqShare{}, err
		}
		s.share.SharedAt = fromMillis(created)
		if byID.Valid {
			s.share.SharedBy = &UserBrief{ID: byID.Int64, Username: byName.String}
		}
		s.share.LastUsedAt = fromNullMillis(lastUsed)
		return s, nil
	}, `SELECT s.credential_seq, s.user_id, u.username, s.created_at, s.shared_by, b.username, s.last_used_at
		FROM credential_shares s JOIN users u ON u.id = s.user_id LEFT JOIN users b ON b.id = s.shared_by
		WHERE s.credential_seq IN (SELECT value FROM json_each(?))
		ORDER BY s.created_at, s.rowid`, string(list))
	if err != nil {
		return err
	}
	for _, s := range shares {
		c := &creds[index[s.seq]]
		c.Shares = append(c.Shares, s.share)
	}
	return nil
}

// withShares fills the shares of a credential just loaded.
func withShares(ctx context.Context, q queryer, c Credential, err error) (Credential, error) {
	if err != nil {
		return Credential{}, err
	}
	creds := []Credential{c}
	if err := loadShares(ctx, q, creds); err != nil {
		return Credential{}, err
	}
	return creds[0], nil
}

// AccessFilter selects credentials for ListAccessibleCredentials. Zero fields
// do not filter.
type AccessFilter struct {
	// RPID keeps credentials whose rp_id equals it case-insensitively.
	RPID string
	// Access keeps only owned (AccessOwner) or shared (AccessShared)
	// credentials.
	Access string
}

// ListCredentials returns the credentials the user owns or that are shared
// with them, newest first. A non-empty rpID keeps only credentials whose rp_id
// equals it case-insensitively.
func (s *Store) ListCredentials(ctx context.Context, userID int64, rpID string) ([]Credential, error) {
	return s.ListAccessibleCredentials(ctx, userID, AccessFilter{RPID: rpID})
}

// ListAccessibleCredentials returns the credentials the user owns or that are
// shared with them, newest first, with their shares.
func (s *Store) ListAccessibleCredentials(ctx context.Context, userID int64, f AccessFilter) ([]Credential, error) {
	query := accessibleQuery
	args := []any{userID, userID, userID}
	if f.RPID != "" {
		query += ` AND c.rp_id_key = ?`
		args = append(args, strings.ToLower(f.RPID))
	}
	switch f.Access {
	case AccessOwner:
		query += ` AND c.user_id = ?`
		args = append(args, userID)
	case AccessShared:
		query += ` AND c.user_id != ?`
		args = append(args, userID)
	}
	creds, err := queryRows(ctx, s.db, scanAccessible(userID), query+credentialOrder, args...)
	if err != nil {
		return nil, err
	}
	return creds, loadShares(ctx, s.db, creds)
}

// GetCredential returns a credential the user owns or that is shared with
// them; any other ID is ErrNotFound.
func (s *Store) GetCredential(ctx context.Context, userID int64, id string) (Credential, error) {
	c, err := getAccessible(ctx, s.db, userID, id)
	return withShares(ctx, s.db, c, err)
}

// GetAnyCredential returns any user's credential, for administrators.
func (s *Store) GetAnyCredential(ctx context.Context, id string) (Credential, error) {
	c, err := getAny(ctx, s.db, id)
	return withShares(ctx, s.db, c, err)
}

// CredentialFilter selects credentials for ListAllCredentials. Zero fields do
// not filter; users that do not exist match nothing.
type CredentialFilter struct {
	OwnerID int64
	// Owner is the owner's username (case-insensitive).
	Owner        string
	SharedWithID int64
	// SharedWith is the username (case-insensitive) of a share recipient.
	SharedWith string
	// RPID matches rp_id case-insensitively.
	RPID string
	// Query is a case-insensitive substring of the rp_id, rp_name, user_name,
	// user_display_name, label, a custom field's label (not its value) or the
	// owner's username. Case folding beyond ASCII only applies to the
	// username.
	Query string
	// Shared keeps credentials shared with at least one user (true) or with
	// nobody (false).
	Shared *bool
	// Limit (positive) and Offset page through the matches.
	Limit, Offset int
}

// ListAllCredentials returns a page of all users' credentials matching f,
// newest first, with their shares, and the number of matches.
func (s *Store) ListAllCredentials(ctx context.Context, f CredentialFilter) ([]Credential, int, error) {
	var where []string
	var args []any
	add := func(cond string, vals ...any) {
		where = append(where, cond)
		args = append(args, vals...)
	}
	// An invalid username matches no key: NULL never equals anything.
	nameKey := func(name string) any {
		if _, key, ok := NormalizeUsername(name); ok {
			return key
		}
		return nil
	}
	if f.OwnerID != 0 {
		add(`c.user_id = ?`, f.OwnerID)
	}
	if f.Owner != "" {
		add(`o.username_key = ?`, nameKey(f.Owner))
	}
	if f.SharedWithID != 0 {
		add(`EXISTS (SELECT 1 FROM credential_shares s WHERE s.credential_seq = c.seq AND s.user_id = ?)`, f.SharedWithID)
	}
	if f.SharedWith != "" {
		add(`EXISTS (SELECT 1 FROM credential_shares s JOIN users u ON u.id = s.user_id
			WHERE s.credential_seq = c.seq AND u.username_key = ?)`, nameKey(f.SharedWith))
	}
	if f.RPID != "" {
		add(`c.rp_id_key = ?`, strings.ToLower(f.RPID))
	}
	if f.Query != "" {
		q := strings.ToLower(f.Query)
		add(`(instr(lower(c.rp_id), ?) OR instr(lower(c.rp_name), ?) OR instr(lower(c.user_name), ?)
			OR instr(lower(c.user_display_name), ?) OR instr(lower(c.label), ?) OR instr(o.username_key, ?)
			OR EXISTS (SELECT 1 FROM json_each(c.fields) WHERE instr(lower(json_extract(value, '$.label')), ?)))`,
			q, q, q, q, q, q, q)
	}
	if f.Shared != nil {
		cond := `EXISTS (SELECT 1 FROM credential_shares s WHERE s.credential_seq = c.seq)`
		if !*f.Shared {
			cond = `NOT ` + cond
		}
		add(cond)
	}
	filter := ""
	if len(where) > 0 {
		filter = ` WHERE ` + strings.Join(where, ` AND `)
	}
	var total int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*)`+credentialsFrom+filter, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	creds, err := queryRows(ctx, s.db, func(r rowScanner) (Credential, error) { return scanCredential(r) },
		`SELECT `+credentialColumns+credentialsFrom+filter+credentialOrder+` LIMIT ? OFFSET ?`,
		append(args, f.Limit, f.Offset)...)
	if err != nil {
		return nil, 0, err
	}
	return creds, total, loadShares(ctx, s.db, creds)
}

var errCredentialIDTaken = &conflictError{"credential id already exists"}

// SaveCredential stores a new credential for the user. Credentials the user
// owns with the same rp_id (case-insensitive) and user_handle are replaced, the
// way an authenticator overwrites a discoverable credential for the same
// account, together with their shares: a new private key reaches nobody until
// the owner shares it again. (Moving the shares would let a credential someone
// else transferred in with keep_access, or a revoked recipient, receive the
// owner's next key.) What the user made of the newest replaced credential
// stays: its label unless c has one, its fields, and the names the user
// edited, which take the place of those on c. If the ID is still taken by
// another credential, nothing changes and ErrConflict is returned. Statistics
// and fields on c are ignored.
func (s *Store) SaveCredential(ctx context.Context, actor Actor, userID int64, c Credential, now time.Time) (Credential, error) {
	var saved Credential
	err := s.inTx(ctx, false, func(tx *sql.Tx) error {
		rpKey := strings.ToLower(c.RPID)
		var prev Credential
		fields := "[]"
		c.edited = ""
		err := tx.QueryRowContext(ctx, `SELECT label, rp_name, user_name, user_display_name, fields, edited FROM credentials
			WHERE user_id = ? AND rp_id_key = ? AND user_handle = ? ORDER BY created_at DESC, seq DESC LIMIT 1`,
			userID, rpKey, c.UserHandle).Scan(&prev.Label, &prev.RPName, &prev.UserName, &prev.UserDisplayName, &fields, &prev.edited)
		switch {
		case err == nil:
			if c.Label == "" {
				c.Label = prev.Label
			}
			for i, col := range nameColumns {
				if prev.isEdited(col) {
					*c.names()[i] = *prev.names()[i]
				}
			}
			c.edited = prev.edited
		case !errors.Is(err, sql.ErrNoRows):
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM credentials WHERE user_id = ? AND rp_id_key = ? AND user_handle = ?`,
			userID, rpKey, c.UserHandle); err != nil {
			return err
		}
		var exists int
		// IDs are unique across all users (schema 1).
		err = tx.QueryRowContext(ctx, `SELECT 1 FROM credentials WHERE id = ?`, c.ID).Scan(&exists)
		if err == nil {
			return errCredentialIDTaken
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO credentials
			(user_id, id, rp_id, rp_id_key, rp_name, user_handle, user_name, user_display_name, alg,
			 private_key, public_key, sign_count, label, origin, created_at, last_used_at, use_count, fields, edited)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
			userID, c.ID, c.RPID, rpKey, c.RPName, c.UserHandle, c.UserName, c.UserDisplayName, c.Alg,
			c.PrivateKey, c.PublicKey, c.SignCount, c.Label, c.Origin, toMillis(now), fields, c.edited)
		if err != nil {
			return err
		}
		saved, err = getAccessible(ctx, tx, userID, c.ID)
		if saved, err = withShares(ctx, tx, saved, err); err != nil {
			return err
		}
		return writeAudit(ctx, tx, now, actor, AuditEntry{Action: "credential.create",
			Subject: &saved.Owner, Credential: saved.audit()})
	})
	if err != nil {
		return Credential{}, err
	}
	return saved, nil
}

// MaxCredentialNameLen is the maximum length in characters of an edited
// rp_name, user_name or user_display_name after trimming.
const MaxCredentialNameLen = 1000

// CredentialUpdate changes a credential; nil fields are left as they are and
// at least one must be set. The names are trimmed. Fields replaces the whole
// list; see normalizeFields for its rules.
type CredentialUpdate struct {
	Label           *string
	RPName          *string
	UserName        *string
	UserDisplayName *string
	Fields          *[]Field
}

// names returns the new values of nameColumns, nil for those left alone.
func (u CredentialUpdate) names() []*string {
	return []*string{u.RPName, u.UserName, u.UserDisplayName}
}

// normalize checks u and returns it with the names trimmed and the fields
// normalized, new field IDs coming from newID.
func (u CredentialUpdate) normalize(newID func() string) (CredentialUpdate, error) {
	if u.Label == nil && u.Fields == nil && !slices.ContainsFunc(u.names(), func(p *string) bool { return p != nil }) {
		return u, Invalid("nothing to update")
	}
	for i, p := range []**string{&u.RPName, &u.UserName, &u.UserDisplayName} {
		if *p == nil {
			continue
		}
		v := strings.TrimSpace(**p)
		if utf8.RuneCountInString(v) > MaxCredentialNameLen {
			return u, Invalid("%s must be at most %d characters", nameColumns[i], MaxCredentialNameLen)
		}
		*p = &v
	}
	if u.Fields != nil {
		fields, err := normalizeFields(*u.Fields, newID)
		if err != nil {
			return u, err
		}
		u.Fields = &fields
	}
	return u, nil
}

// UpdateCredential changes a credential the user owns. A credential shared
// with the user is ErrForbidden.
func (s *Store) UpdateCredential(ctx context.Context, actor Actor, userID int64, id string, u CredentialUpdate, now time.Time) (Credential, error) {
	return s.updateCredential(ctx, actor, u, now, func(q queryer) (Credential, error) {
		c, err := getAccessible(ctx, q, userID, id)
		if err == nil && c.Access != AccessOwner {
			return Credential{}, ErrForbidden
		}
		return c, err
	})
}

// AdminUpdateCredential changes any credential.
func (s *Store) AdminUpdateCredential(ctx context.Context, actor Actor, id string, u CredentialUpdate, now time.Time) (Credential, error) {
	return s.updateCredential(ctx, actor, u, now, func(q queryer) (Credential, error) { return getAny(ctx, q, id) })
}

// updateCredential applies u to the credential load returns. When anything
// changed it records credential.update with the changes: from and to for the
// label and names, the labels (never the values) of the fields added, removed
// and changed (all three empty when only the order changed). Names that
// changed count as edited from then on, which SaveCredential honours.
func (s *Store) updateCredential(ctx context.Context, actor Actor, u CredentialUpdate, now time.Time, load func(queryer) (Credential, error)) (Credential, error) {
	u, err := u.normalize(newFieldID)
	if err != nil {
		return Credential{}, err
	}
	var out Credential
	err = s.inTx(ctx, false, func(tx *sql.Tx) error {
		c, err := load(tx)
		if err != nil {
			return err
		}
		ref := c.audit()
		var (
			detail = map[string]any{}
			sets   []string
			args   []any
		)
		set := func(column string, value any) {
			sets = append(sets, column+" = ?")
			args = append(args, value)
		}
		text := func(column string, field, to *string) bool {
			if to == nil || *to == *field {
				return false
			}
			detail[column] = fromTo{*field, *to}
			set(column, *to)
			*field = *to
			return true
		}
		text("label", &c.Label, u.Label)
		var edited []string
		for i, col := range nameColumns {
			if text(col, c.names()[i], u.names()[i]) {
				edited = append(edited, col)
			}
		}
		before := c.edited
		if c.markEdited(edited...); c.edited != before {
			set("edited", c.edited)
		}
		if u.Fields != nil && !slices.Equal(c.Fields, *u.Fields) {
			data, err := json.Marshal(*u.Fields)
			if err != nil {
				return err
			}
			detail["fields"] = diffFields(c.Fields, *u.Fields)
			set("fields", string(data))
			c.Fields = *u.Fields
		}
		if len(sets) > 0 {
			if _, err := tx.ExecContext(ctx, `UPDATE credentials SET `+strings.Join(sets, ", ")+` WHERE seq = ?`,
				append(args, c.seq)...); err != nil {
				return err
			}
			if err := writeAudit(ctx, tx, now, actor, AuditEntry{Action: "credential.update",
				Subject: &c.Owner, Credential: ref, Detail: detail}); err != nil {
				return err
			}
		}
		out, err = withShares(ctx, tx, c, nil)
		return err
	})
	return out, err
}

// fieldChanges is the fields entry of a credential.update event.
type fieldChanges struct {
	Added   []string `json:"added"`
	Removed []string `json:"removed"`
	Changed []string `json:"changed"`
}

// diffFields compares two lists of fields by ID and names the fields added,
// removed and changed (label, type or value) by their labels.
func diffFields(from, to []Field) fieldChanges {
	d := fieldChanges{Added: []string{}, Removed: []string{}, Changed: []string{}}
	old := make(map[string]Field, len(from))
	for _, f := range from {
		old[f.ID] = f
	}
	for _, f := range to {
		switch o, ok := old[f.ID]; {
		case !ok:
			d.Added = append(d.Added, f.Label)
		case o != f:
			d.Changed = append(d.Changed, f.Label)
		}
		delete(old, f.ID)
	}
	for _, f := range from {
		if _, ok := old[f.ID]; ok {
			d.Removed = append(d.Removed, f.Label)
		}
	}
	return d
}

// MarkCredentialUsed increments the use counter of a credential the user owns
// or that is shared with them and records the time, on the credential and on
// the user's share.
func (s *Store) MarkCredentialUsed(ctx context.Context, userID int64, id string, now time.Time) error {
	return s.inTx(ctx, false, func(tx *sql.Tx) error {
		c, err := getAccessible(ctx, tx, userID, id)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE credentials SET use_count = use_count + 1, last_used_at = ? WHERE seq = ?`, toMillis(now), c.seq); err != nil {
			return err
		}
		if c.Access == AccessShared {
			_, err = tx.ExecContext(ctx, `UPDATE credential_shares SET last_used_at = ? WHERE credential_seq = ? AND user_id = ?`,
				toMillis(now), c.seq, userID)
		}
		return err
	})
}

// DeleteCredential takes a credential away from the user: one they own is
// deleted with its shares; one shared with them loses that share, which is
// recorded as credential.leave when the actor is the user and as
// credential.unshare otherwise.
func (s *Store) DeleteCredential(ctx context.Context, actor Actor, userID int64, id string, now time.Time) error {
	return s.inTx(ctx, false, func(tx *sql.Tx) error {
		c, err := getAccessible(ctx, tx, userID, id)
		if err != nil {
			return err
		}
		_, err = removeAccess(ctx, tx, actor, c, userID, now)
		return err
	})
}

// AdminDeleteCredential deletes any credential with its shares.
func (s *Store) AdminDeleteCredential(ctx context.Context, actor Actor, id string, now time.Time) error {
	return s.inTx(ctx, false, func(tx *sql.Tx) error {
		c, err := getAny(ctx, tx, id)
		if err != nil {
			return err
		}
		return deleteCredential(ctx, tx, actor, c, now)
	})
}

// audit names c in audit events.
func (c Credential) audit() *AuditCredential {
	return &AuditCredential{ID: c.ID, RPID: c.RPID, UserName: c.UserName}
}

// deleteCredential deletes c; its shares go with it (ON DELETE CASCADE).
func deleteCredential(ctx context.Context, q queryer, actor Actor, c Credential, now time.Time) error {
	if _, err := q.ExecContext(ctx, `DELETE FROM credentials WHERE seq = ?`, c.seq); err != nil {
		return err
	}
	return writeAudit(ctx, q, now, actor, AuditEntry{Action: "credential.delete", Subject: &c.Owner, Credential: c.audit()})
}

// removeAccess deletes c when userID owns it, and otherwise removes its share
// with userID (see DeleteCredential). It returns StatusDeleted or StatusLeft.
func removeAccess(ctx context.Context, q queryer, actor Actor, c Credential, userID int64, now time.Time) (string, error) {
	if c.Owner.ID == userID {
		return StatusDeleted, deleteCredential(ctx, q, actor, c, now)
	}
	user, err := userBrief(ctx, q, userID)
	if err != nil {
		return "", err
	}
	action := "credential.unshare"
	if actor.ID == userID {
		action = "credential.leave"
	}
	if _, err := removeShare(ctx, q, actor, c, user, action, now); err != nil {
		return "", err
	}
	return StatusLeft, nil
}
