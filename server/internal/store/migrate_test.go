package store

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
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

// dumpV0 returns every row of the version 0 tables, restricted to the
// version 0 columns, as strings.
func dumpV0(t *testing.T, db *sql.DB) map[string][][]string {
	t.Helper()
	out := map[string][][]string{}
	for table, cols := range map[string]string{
		"users":       "id, username, username_key, password_hash, is_admin, created_at",
		"sessions":    "token, user_id, created_at, expires_at",
		"credentials": "seq, user_id, id, rp_id, rp_id_key, rp_name, user_handle, user_name, user_display_name, alg, private_key, public_key, sign_count, label, origin, created_at, last_used_at, use_count",
	} {
		rows, err := db.Query(`SELECT ` + cols + ` FROM ` + table + ` ORDER BY 1`)
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

func TestMigrateRefusesDuplicateCredentialIDs(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "passkey-box.db")
	// Version 0 only kept IDs unique per user.
	writeV0Database(t, path, map[int64][]string{1: {"YQ", "c2FtZQ"}, 2: {"c2FtZQ"}})
	before := dumpV0(t, openRaw(t, path))

	if _, err := Open(path); err == nil || !strings.Contains(err.Error(), `"c2FtZQ"`) {
		t.Fatalf("Open = %v, want an error naming the duplicate ID", err)
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
