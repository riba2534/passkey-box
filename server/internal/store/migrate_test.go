package store

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// openRaw opens a database file without the store, with the same pragmas.
func openRaw(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	return db
}

// writeV0Database creates a database the way passkey-box 0.5.0 and earlier
// did, with users, sessions and credentials.
func writeV0Database(t *testing.T, path string, credentialIDs map[int64][]string) {
	t.Helper()
	db := openRaw(t, path)
	mustExec(t, db, schema)
	for id, name := range map[int64]string{1: "admin", 2: "Alice", 3: "bob"} {
		mustExec(t, db, `INSERT INTO users (id, username, username_key, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
			id, name, strings.ToLower(name), "$2a$04$hash-"+name, id == 1, 1763500000000+id)
		mustExec(t, db, `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
			fmt.Sprintf("token-%d", id), id, 1763500000000, 1797882141547)
	}
	n := 0
	for userID, ids := range credentialIDs {
		for _, cid := range ids {
			n++
			mustExec(t, db, `INSERT INTO credentials
				(user_id, id, rp_id, rp_id_key, rp_name, user_handle, user_name, user_display_name, alg,
				 private_key, public_key, sign_count, label, origin, created_at, last_used_at, use_count)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				userID, cid, "Link.com", "link.com", "Link", fmt.Sprintf("aGFuZGxl%d", n), fmt.Sprintf("u%d@example.com", n), "U",
				-7, "cHJpdmF0ZS0"+cid, "cHVibGlj", 0, "备注 "+cid, "https://link.com", 1763700000000+int64(n),
				sql.NullInt64{Int64: 1763800000000, Valid: n%2 == 0}, n%3)
		}
	}
}

func mustExec(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
}

// v0Columns are the version 0 tables and their columns.
var v0Columns = map[string]string{
	"users":       "id, username, username_key, password_hash, is_admin, created_at",
	"sessions":    "token, user_id, created_at, expires_at",
	"credentials": "seq, user_id, id, rp_id, rp_id_key, rp_name, user_handle, user_name, user_display_name, alg, private_key, public_key, sign_count, label, origin, created_at, last_used_at, use_count",
}

// v1Columns are the version 1 tables and their columns.
var v1Columns = map[string]string{
	"users":             v0Columns["users"] + ", disabled, note",
	"sessions":          v0Columns["sessions"],
	"credentials":       v0Columns["credentials"],
	"credential_shares": "credential_seq, user_id, shared_by, created_at, last_used_at",
	"api_tokens":        "id, user_id, name, token_hash, prefix, read_only, created_at, expires_at, last_used_at",
	"audit_log":         "id, at, actor_id, actor_name, via, action, subject_id, subject_name, target_id, target_name, credential_id, rp_id, account, detail",
}

// writeV1Database creates a database the way passkey-box 0.6.0 left it: the
// version 0 rows migrated to schema 1, then a disabled user, notes, shares,
// an API token and audit events.
func writeV1Database(t *testing.T, path string) {
	t.Helper()
	writeV0Database(t, path, map[int64][]string{1: {"YQ", "Yg"}, 2: {"Yw", "ZA"}, 3: {"ZQ"}})
	db := openRaw(t, path)
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := migrateV1(t.Context(), tx); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(`PRAGMA user_version = 1`); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	mustExec(t, db, `UPDATE users SET disabled = 1, note = '离职' WHERE id = 3`)
	mustExec(t, db, `UPDATE users SET note = 'ops' WHERE id = 1`)
	mustExec(t, db, `INSERT INTO credential_shares (credential_seq, user_id, shared_by, created_at, last_used_at)
		SELECT seq, 3, 2, 1763900000000, NULL FROM credentials WHERE id = 'Yw'`)
	mustExec(t, db, `INSERT INTO credential_shares (credential_seq, user_id, shared_by, created_at, last_used_at)
		SELECT seq, 2, 1, 1763900000001, 1763900005000 FROM credentials WHERE id = 'YQ'`)
	mustExec(t, db, `INSERT INTO api_tokens (user_id, name, token_hash, prefix, read_only, created_at, expires_at, last_used_at)
		VALUES (2, 'claude', 'hash-1', 'pkb_AbCdEfGh', 1, 1763900000000, NULL, 1763900001000)`)
	mustExec(t, db, `INSERT INTO audit_log (at, actor_id, actor_name, via, action, subject_id, subject_name, target_id, target_name,
		credential_id, rp_id, account, detail)
		VALUES (1763900000000, 2, 'Alice', 'session', 'credential.share', 2, 'Alice', 3, 'bob', 'Yw', 'Link.com', 'u3@example.com', '{}'),
		(1763900000500, 1, 'admin', 'token:ops', 'credential.update', 1, 'admin', NULL, '', 'YQ', 'Link.com', 'u1@example.com',
		 '{"label":{"from":"","to":"备注 YQ"}}')`)
}

// dumpV0 returns every row of the version 0 tables, restricted to the
// version 0 columns, as strings.
func dumpV0(t *testing.T, db *sql.DB) map[string][][]string {
	t.Helper()
	return dumpRows(t, db, v0Columns)
}

// dumpRows returns every row of the tables, restricted to the columns, as
// strings.
func dumpRows(t *testing.T, db *sql.DB, tables map[string]string) map[string][][]string {
	t.Helper()
	out := map[string][][]string{}
	for table, cols := range tables {
		rows, err := db.Query(`SELECT ` + cols + ` FROM ` + table + ` ORDER BY 1, 2`)
		if err != nil {
			t.Fatal(err)
		}
		n := len(strings.Split(cols, ","))
		for rows.Next() {
			vals := make([]any, n)
			ptrs := make([]any, n)
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				t.Fatal(err)
			}
			row := make([]string, n)
			for i, v := range vals {
				row[i] = fmt.Sprintf("%T:%v", v, v)
			}
			out[table] = append(out[table], row)
		}
		rows.Close()
	}
	return out
}

func userVersion(t *testing.T, db *sql.DB) int {
	t.Helper()
	var v int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

func snapshots(t *testing.T, dir string) []string {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(dir, "*.pre-v*"))
	if err != nil {
		t.Fatal(err)
	}
	return matches
}

func TestMigrateFromV0KeepsEveryRow(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "passkey-box.db")
	writeV0Database(t, path, map[int64][]string{1: {"YQ", "Yg", "Yw", "ZA", "ZQ"}, 2: {"Zg"}})
	before := dumpV0(t, openRaw(t, path))
	if len(before["credentials"]) != 6 || len(before["users"]) != 3 || len(before["sessions"]) != 3 {
		t.Fatalf("fixture = %v", before)
	}

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.Migration.From != 0 || s.Migration.To != SchemaVersion || s.Migration.Snapshot == "" {
		t.Fatalf("migration = %+v", s.Migration)
	}
	if got := dumpV0(t, s.db); !reflect.DeepEqual(got, before) {
		t.Fatalf("rows changed by the migration:\nbefore %v\nafter  %v", before, got)
	}
	if v := userVersion(t, s.db); v != SchemaVersion {
		t.Fatalf("user_version = %d", v)
	}
	// Existing users keep working: their sessions and credentials are intact
	// and they are active with an empty note.
	u, err := s.SessionUser(t.Context(), "token-2", fromMillis(1763600000000))
	if err != nil || u.Username != "Alice" || u.Disabled || u.Note != "" || u.CredentialCount != 1 || u.SharedInCount != 0 {
		t.Fatalf("session user = %+v, %v", u, err)
	}
	creds, err := s.ListCredentials(t.Context(), 1, "LINK.com")
	if err != nil || len(creds) != 5 || creds[0].PrivateKey != "cHJpdmF0ZS0ZQ" || creds[0].Label != "备注 ZQ" {
		t.Fatalf("credentials = %+v, %v", creds, err)
	}
	expectSchema2Defaults(t, s.db, 6)

	// The snapshot is a complete copy of the database before the change.
	if got := snapshots(t, dir); len(got) != 1 || got[0] != s.Migration.Snapshot {
		t.Fatalf("snapshots = %v, migration %+v", got, s.Migration)
	}
	snap, err := sql.Open("sqlite", "file:"+s.Migration.Snapshot+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer snap.Close()
	if v := userVersion(t, snap); v != 0 {
		t.Fatalf("snapshot user_version = %d", v)
	}
	if got := dumpV0(t, snap); !reflect.DeepEqual(got, before) {
		t.Fatalf("snapshot differs:\n%v\n%v", before, got)
	}
	s.Close()

	// Opening again is a no-op: no second migration or snapshot.
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.Migration.From != SchemaVersion || s.Migration.Snapshot != "" {
		t.Fatalf("second open migration = %+v", s.Migration)
	}
	if got := snapshots(t, dir); len(got) != 1 {
		t.Fatalf("snapshots after reopen = %v", got)
	}
	if got := dumpV0(t, s.db); !reflect.DeepEqual(got, before) {
		t.Fatal("rows changed by reopening")
	}
}

// expectSchema2Defaults checks that all n credentials have the defaults of
// the schema 2 columns.
func expectSchema2Defaults(t *testing.T, db *sql.DB, n int) {
	t.Helper()
	var defaults, total int
	if err := db.QueryRow(`SELECT COUNT(*) FILTER (WHERE fields = '[]' AND edited = ''), COUNT(*) FROM credentials`).Scan(&defaults, &total); err != nil {
		t.Fatal(err)
	}
	if defaults != n || total != n {
		t.Fatalf("%d of %d credentials have the schema 2 defaults, want %d", defaults, total, n)
	}
}

// The live database is at version 1: migrating it to 2 must keep every row of
// every table and copy it first.
func TestMigrateFromV1KeepsEveryRow(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "passkey-box.db")
	writeV1Database(t, path)
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	before := dumpRows(t, openRaw(t, path), v1Columns)
	if len(before["credentials"]) != 5 || len(before["credential_shares"]) != 2 || len(before["api_tokens"]) != 1 ||
		len(before["audit_log"]) != 2 || len(before["users"]) != 3 {
		t.Fatalf("fixture = %v", before)
	}

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.Migration.From != 1 || s.Migration.To != 2 || s.Migration.Snapshot == "" {
		t.Fatalf("migration = %+v", s.Migration)
	}
	if got := dumpRows(t, s.db, v1Columns); !reflect.DeepEqual(got, before) {
		t.Fatalf("rows changed by the migration:\nbefore %v\nafter  %v", before, got)
	}
	if v := userVersion(t, s.db); v != 2 {
		t.Fatalf("user_version = %d", v)
	}
	expectSchema2Defaults(t, s.db, 5)
	// The store reads the migrated rows: shares, tokens and the disabled user.
	c, err := s.GetCredential(t.Context(), 1, "YQ")
	if err != nil || c.Label != "备注 YQ" || len(c.Shares) != 1 || c.Shares[0].User.Username != "Alice" || c.Shares[0].LastUsedAt == nil {
		t.Fatalf("credential = %+v, %v", c, err)
	}
	if u, err := s.GetUser(t.Context(), 3); err != nil || !u.Disabled || u.Note != "离职" || u.SharedInCount != 1 {
		t.Fatalf("bob = %+v, %v", u, err)
	}
	if ev, err := s.ListAudit(t.Context(), AuditFilter{Limit: 10}); err != nil || len(ev) != 2 || ev[0].Via != "token:ops" {
		t.Fatalf("audit = %+v, %v", ev, err)
	}

	// The snapshot is a copy of the version 1 database, as private as it.
	if got := snapshots(t, dir); len(got) != 1 || got[0] != s.Migration.Snapshot || !strings.Contains(got[0], ".pre-v2-") {
		t.Fatalf("snapshots = %v, migration %+v", got, s.Migration)
	}
	if fi, err := os.Stat(s.Migration.Snapshot); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("snapshot mode = %v, %v", fi.Mode(), err)
	}
	snap, err := sql.Open("sqlite", "file:"+s.Migration.Snapshot+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer snap.Close()
	if v := userVersion(t, snap); v != 1 {
		t.Fatalf("snapshot user_version = %d", v)
	}
	if got := dumpRows(t, snap, v1Columns); !reflect.DeepEqual(got, before) {
		t.Fatalf("snapshot differs:\n%v\n%v", before, got)
	}
	if v2, err := hasSchemaV2(t.Context(), snap); err != nil || v2 {
		t.Fatalf("snapshot has the schema 2 columns: %v, %v", v2, err)
	}
	s.Close()

	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.Migration.From != 2 || s.Migration.Snapshot != "" || len(snapshots(t, dir)) != 1 {
		t.Fatalf("second open migration = %+v", s.Migration)
	}
}

// 0.6.0 must keep working on a schema 2 database after a rollback. These are
// its credential statements (server/internal/store/credentials.go at c3919dd).
func TestVersion1StatementsWorkAfterMigration(t *testing.T) {
	const (
		columns = `c.seq, c.user_id, o.username, c.id, c.rp_id, c.rp_name, c.user_handle, c.user_name,
	c.user_display_name, c.alg, c.private_key, c.public_key, c.sign_count, c.label, c.origin, c.created_at,
	c.last_used_at, c.use_count`
		from       = ` FROM credentials c JOIN users o ON o.id = c.user_id`
		accessible = `SELECT ` + columns + `, sh.created_at` + from + `
	LEFT JOIN credential_shares sh ON sh.credential_seq = c.seq AND sh.user_id = ?`
		listQuery = accessible + `
	WHERE c.seq IN (SELECT seq FROM credentials WHERE user_id = ?
		UNION ALL SELECT credential_seq FROM credential_shares WHERE user_id = ?)` + ` AND c.rp_id_key = ?` + ` ORDER BY c.created_at DESC, c.seq DESC`
		getQuery = accessible + `
		WHERE c.id = ? AND (c.user_id = ? OR sh.user_id IS NOT NULL)`
		replace = `DELETE FROM credentials WHERE user_id = ? AND rp_id_key = ? AND user_handle = ?`
		insert  = `INSERT INTO credentials
			(user_id, id, rp_id, rp_id_key, rp_name, user_handle, user_name, user_display_name, alg,
			 private_key, public_key, sign_count, label, origin, created_at, last_used_at, use_count)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`
		relabel = `UPDATE credentials SET label = ? WHERE seq = ?`
		use     = `UPDATE credentials SET use_count = use_count + 1, last_used_at = ? WHERE seq = ?`
	)
	path := filepath.Join(t.TempDir(), "passkey-box.db")
	writeV1Database(t, path)
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	// One credential has a custom field and an edited name before the rollback.
	mustExec(t, s.db, `UPDATE credentials SET user_name = 'edited', edited = 'user_name',
		fields = '[{"id":"ZmllbGQx","label":"PIN","type":"password","value":"1234"}]' WHERE id = 'Yw'`)
	s.Close()

	db := openRaw(t, path)
	scanRow := func(r interface{ Scan(...any) error }) []any {
		t.Helper()
		vals := make([]any, 19)
		ptrs := make([]any, len(vals))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := r.Scan(ptrs...); err != nil {
			t.Fatal(err)
		}
		return vals
	}
	rows, err := db.Query(listQuery, 2, 2, 2, "link.com")
	if err != nil {
		t.Fatal(err)
	}
	var listed []string
	for rows.Next() {
		row := scanRow(rows)
		listed = append(listed, fmt.Sprintf("%v shared:%v", row[3], row[18] != nil))
	}
	rows.Close()
	// Alice owns Yw and ZA and has a share of YQ.
	slices.Sort(listed)
	if want := []string{"YQ shared:true", "Yw shared:false", "ZA shared:false"}; !slices.Equal(listed, want) {
		t.Fatalf("0.6.0 list = %v, want %v", listed, want)
	}
	row := scanRow(db.QueryRow(getQuery, 2, "Yw", 2))
	if row[3] != "Yw" || row[7] != "edited" || row[13] != "备注 Yw" {
		t.Fatalf("0.6.0 get = %v", row)
	}
	seq := row[0]
	mustExec(t, db, relabel, "rolled back", seq)
	mustExec(t, db, use, 1763999999999, seq)
	// Re-registering in 0.6.0 replaces the credential with one that has the
	// schema 2 defaults.
	var handle string
	if err := db.QueryRow(`SELECT user_handle FROM credentials WHERE id = 'Yw'`).Scan(&handle); err != nil {
		t.Fatal(err)
	}
	mustExec(t, db, replace, 2, "link.com", handle)
	mustExec(t, db, insert, 2, "bmV3", "Link.com", "link.com", "Link", handle, "new@example.com", "New", -7,
		"a2V5", "", 0, "", "https://link.com", 1764000000000)

	var fields, edited string
	if err := db.QueryRow(`SELECT fields, edited FROM credentials WHERE id = 'bmV3'`).Scan(&fields, &edited); err != nil ||
		fields != "[]" || edited != "" {
		t.Fatalf("credential registered by 0.6.0: fields %q, edited %q, %v", fields, edited, err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.Migration.From != 2 || s.Migration.Snapshot != "" {
		t.Fatalf("migration after the rollback = %+v", s.Migration)
	}
	if c, err := s.GetCredential(t.Context(), 2, "bmV3"); err != nil || c.UserName != "new@example.com" {
		t.Fatalf("credential registered by 0.6.0 = %+v, %v", c, err)
	}
}

func TestMigrateRefusesDuplicateCredentialIDs(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "passkey-box.db")
	// Version 0 only kept IDs unique per user.
	writeV0Database(t, path, map[int64][]string{1: {"YQ", "c2FtZQ"}, 2: {"c2FtZQ"}})
	before := dumpV0(t, openRaw(t, path))

	for range 3 { // a restart loop
		if _, err := Open(path); err == nil || !strings.Contains(err.Error(), `"c2FtZQ"`) {
			t.Fatalf("Open = %v, want an error naming the duplicate ID", err)
		}
	}
	if got := snapshots(t, dir); len(got) != 0 {
		t.Fatalf("snapshots = %v; a database that cannot be migrated must not be copied", got)
	}
	db := openRaw(t, path)
	if v := userVersion(t, db); v != 0 {
		t.Fatalf("user_version = %d after a failed migration", v)
	}
	if got := dumpV0(t, db); !reflect.DeepEqual(got, before) {
		t.Fatal("rows changed by a failed migration")
	}
	var cols int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('users') WHERE name IN ('disabled', 'note')`).Scan(&cols); err != nil || cols != 0 {
		t.Fatalf("new user columns = %d, %v; the migration must roll back", cols, err)
	}
	var tables int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE name IN ('credential_shares', 'api_tokens', 'audit_log')`).Scan(&tables); err != nil || tables != 0 {
		t.Fatalf("new tables = %d, %v; the migration must roll back", tables, err)
	}
}

func TestNewDatabaseNeedsNoSnapshot(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "new.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.Migration.To != SchemaVersion || s.Migration.Snapshot != "" {
		t.Fatalf("migration = %+v", s.Migration)
	}
	if got := snapshots(t, dir); len(got) != 0 {
		t.Fatalf("snapshots = %v", got)
	}
}

func TestNewerSchemaVersionStillOpens(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pkb.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	mustExec(t, s.db, fmt.Sprintf(`PRAGMA user_version = %d`, SchemaVersion+1))
	s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.Migration.From != SchemaVersion+1 || s.Migration.Snapshot != "" {
		t.Fatalf("migration = %+v", s.Migration)
	}
}

// The deploy script rolls back to the previous build, which knows only the
// version 0 schema. Its statements must keep working on a migrated database.
func TestVersion0StatementsWorkAfterMigration(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "passkey-box.db")
	writeV0Database(t, path, map[int64][]string{2: {"YQ"}})
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	// Share Alice's credential with bob, as 0.6.0 would.
	mustExec(t, s.db, `INSERT INTO credential_shares (credential_seq, user_id, shared_by, created_at) SELECT seq, 3, 2, 1 FROM credentials WHERE id = 'YQ'`)
	s.Close()

	db := openRaw(t, path)
	// The 0.5.0 schema statement, user and credential queries and inserts.
	mustExec(t, db, schema)
	var name string
	var count int
	if err := db.QueryRow(`SELECT u.username, (SELECT COUNT(*) FROM credentials c WHERE c.user_id = u.id),
		(SELECT MAX(c.last_used_at) FROM credentials c WHERE c.user_id = u.id) IS NULL FROM users u WHERE u.username_key = 'alice'`).Scan(&name, &count, new(bool)); err != nil || count != 1 {
		t.Fatalf("v0 user query = %s %d %v", name, count, err)
	}
	mustExec(t, db, `INSERT INTO users (username, username_key, password_hash, is_admin, created_at) VALUES ('carol', 'carol', 'h', 0, 1)`)
	mustExec(t, db, `DELETE FROM credentials WHERE user_id = 2 AND rp_id_key = 'example.com' AND user_handle = 'aA'`)
	mustExec(t, db, `INSERT INTO credentials
		(user_id, id, rp_id, rp_id_key, rp_name, user_handle, user_name, user_display_name, alg,
		 private_key, public_key, sign_count, label, origin, created_at, last_used_at, use_count)
		VALUES (2, 'bmV3', 'example.com', 'example.com', '', 'aA', '', '', -7, 'a2V5', '', 0, '', '', 1, NULL, 0)`)
	mustExec(t, db, `UPDATE credentials SET use_count = use_count + 1, last_used_at = 5 WHERE user_id = 2 AND id = 'YQ'`)
	// Deleting a user still cascades through the new tables.
	mustExec(t, db, `DELETE FROM users WHERE id = 2`)
	var left int
	if err := db.QueryRowContext(ctx, `SELECT (SELECT COUNT(*) FROM credentials) + (SELECT COUNT(*) FROM credential_shares)`).Scan(&left); err != nil || left != 0 {
		t.Fatalf("rows left after deleting alice = %d, %v", left, err)
	}
}

func TestSnapshotPath(t *testing.T) {
	now := fromMillis(1763860923000) // 2025-11-23T01:22:03Z
	for path, want := range map[string]string{
		"/data/passkey-box.db": "/data/passkey-box.pre-v1-20251123T012203Z.db",
		"./data/pkb":           "./data/pkb.pre-v1-20251123T012203Z",
	} {
		if got := snapshotPath(path, 1, now); got != want {
			t.Errorf("snapshotPath(%q) = %q, want %q", path, got, want)
		}
	}
	if _, err := os.Stat(snapshotPath(filepath.Join(t.TempDir(), "x.db"), 1, now)); !os.IsNotExist(err) {
		t.Fatal("snapshotPath must not create files")
	}
}
