package store

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Start-up makes whoever holds PKB_ADMIN_USERNAME an administrator, so that
// name can be neither given to another user nor taken from the bootstrap
// administrator.
func TestBootstrapAdminNameCannotChangeHands(t *testing.T) {
	s := openTest(t)
	ctx := t.Context()
	if _, err := s.EnsureAdmin(ctx, "admin", "pw", t0); err != nil {
		t.Fatal(err)
	}
	admin, _ := resolveUser(ctx, s.db, UserKey{Username: "admin"})
	bob, _ := s.CreateUser(ctx, "bob", "pw", false, t0)
	actor := Actor{ID: admin.ID, Name: "admin", Via: "session"}
	rename := func(id int64, name string) error {
		_, err := s.UpdateUser(ctx, actor, id, UserUpdate{Username: &name}, t0)
		return err
	}
	var inv *InvalidError
	if err := rename(admin.ID, "hpc"); !errors.As(err, &inv) {
		t.Fatalf("renaming the bootstrap administrator = %v", err)
	}
	if err := rename(bob.ID, "ADMIN"); !errors.Is(err, ErrConflict) {
		t.Fatalf("renaming bob to the bootstrap name = %v", err)
	}
	// Free while the bootstrap account is deleted, the name stays reserved.
	if err := s.DeleteUser(ctx, SystemActor, admin.ID, t0); err != nil {
		t.Fatal(err)
	}
	if err := rename(bob.ID, "admin"); !errors.Is(err, ErrConflict) {
		t.Fatalf("renaming bob to the free bootstrap name = %v", err)
	}
	if _, err := s.EnsureAdmin(ctx, "admin", "pw", t0); err != nil {
		t.Fatal(err)
	}
	admin, _ = resolveUser(ctx, s.db, UserKey{Username: "admin"})
	if _, err := s.UpdateUsers(ctx, actor, []UserEdit{{User: UserKey{ID: bob.ID}, UserUpdate: UserUpdate{Username: new("Admin")}}}, true, t0); err == nil {
		t.Fatal("batch rename to the bootstrap name succeeded")
	}
	// Changing only the case keeps the name with the same user.
	if err := rename(admin.ID, "Admin"); err != nil {
		t.Fatalf("changing the case = %v", err)
	}
	if err := rename(bob.ID, "robert"); err != nil {
		t.Fatalf("an ordinary rename = %v", err)
	}
	if !s.ReservedUsername(" ADMIN ") || s.ReservedUsername("robert") {
		t.Fatal("ReservedUsername")
	}
	// Without a bootstrap administrator nothing is reserved.
	other := openTest(t)
	if other.ReservedUsername("admin") {
		t.Fatal("a store without EnsureAdmin reserves a name")
	}
}

// sqlite3 .dump does not keep user_version: a migrated database restored from
// a logical backup must not be migrated (and copied) again.
func TestLogicalBackupRestoreIsNotMigratedAgain(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "pkb.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateUser(t.Context(), "alice", "pw", false, t0); err != nil {
		t.Fatal(err)
	}
	mustExec(t, s.db, `PRAGMA user_version = 0`)
	s.Close()

	s, err = Open(path)
	if err != nil {
		t.Fatalf("Open after a logical restore = %v", err)
	}
	defer s.Close()
	if v := userVersion(t, s.db); v != SchemaVersion || s.Migration.Snapshot != "" {
		t.Fatalf("user_version = %d, migration %+v", v, s.Migration)
	}
	if got := snapshots(t, dir); len(got) != 0 {
		t.Fatalf("snapshots = %v", got)
	}
	if _, err := s.Authenticate(t.Context(), "alice", "pw"); err != nil {
		t.Fatal(err)
	}
}

// A schema 1 database restored from a logical backup is migrated once, like
// the version 1 database it was.
func TestLogicalBackupOfSchema1IsMigrated(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "pkb.db")
	writeV1Database(t, path)
	db := openRaw(t, path)
	mustExec(t, db, `PRAGMA user_version = 0`)
	before := dumpRows(t, db, v1Columns)

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.Migration.From != 1 || s.Migration.To != 2 || s.Migration.Snapshot == "" || userVersion(t, s.db) != 2 {
		t.Fatalf("migration = %+v", s.Migration)
	}
	if got := dumpRows(t, s.db, v1Columns); !reflect.DeepEqual(got, before) {
		t.Fatal("rows changed by the migration")
	}
	expectSchema2Defaults(t, s.db, 5)
	if got := snapshots(t, dir); len(got) != 1 {
		t.Fatalf("snapshots = %v", got)
	}
}

// 0.6.0 sets version 1 on a schema 2 database restored from a logical backup,
// which already has the schema 2 columns.
func TestSchema2AtVersion1IsNotMigratedAgain(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "pkb.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	mustExec(t, s.db, `PRAGMA user_version = 1`)
	s.Close()

	s, err = Open(path)
	if err != nil {
		t.Fatalf("Open = %v", err)
	}
	defer s.Close()
	if v := userVersion(t, s.db); v != 2 || s.Migration.From != 2 || s.Migration.Snapshot != "" {
		t.Fatalf("user_version = %d, migration %+v", v, s.Migration)
	}
	if got := snapshots(t, dir); len(got) != 0 {
		t.Fatalf("snapshots = %v", got)
	}
}

func TestPartialSchemaV1IsRefused(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pkb.db")
	writeV0Database(t, path, nil)
	mustExec(t, openRaw(t, path), `CREATE TABLE audit_log (id INTEGER PRIMARY KEY)`)
	if _, err := Open(path); err == nil || !strings.Contains(err.Error(), "part of schema 1") {
		t.Fatalf("Open = %v", err)
	}
}

func TestPartialSchemaV2IsRefused(t *testing.T) {
	for name, tc := range map[string]struct {
		write   func(t *testing.T, path string)
		version int
		stmts   []string
		want    string
	}{
		"one column at version 1": {func(t *testing.T, path string) { writeV1Database(t, path) }, 1,
			[]string{`ALTER TABLE credentials ADD COLUMN edited TEXT NOT NULL DEFAULT ''`}, "part of schema 2"},
		"one column at version 0": {func(t *testing.T, path string) { writeV1Database(t, path) }, 0,
			[]string{`ALTER TABLE credentials ADD COLUMN fields TEXT NOT NULL DEFAULT '[]'`}, "part of schema 2"},
		"without schema 1": {func(t *testing.T, path string) { writeV0Database(t, path, nil) }, 0,
			[]string{`ALTER TABLE credentials ADD COLUMN fields TEXT NOT NULL DEFAULT '[]'`,
				`ALTER TABLE credentials ADD COLUMN edited TEXT NOT NULL DEFAULT ''`}, "schema 2 without schema 1"},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "pkb.db")
			tc.write(t, path)
			db := openRaw(t, path)
			for _, stmt := range tc.stmts {
				mustExec(t, db, stmt)
			}
			mustExec(t, db, fmt.Sprintf(`PRAGMA user_version = %d`, tc.version))
			if _, err := Open(path); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("Open = %v, want %q", err, tc.want)
			}
			if got := snapshots(t, dir); len(got) != 0 {
				t.Fatalf("snapshots = %v", got)
			}
			if v := userVersion(t, db); v != tc.version {
				t.Fatalf("user_version = %d", v)
			}
		})
	}
}

func TestSnapshotIsAsPrivateAsTheDatabase(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "passkey-box.db")
	writeV0Database(t, path, map[int64][]string{1: {"YQ"}})
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	fi, err := os.Stat(s.Migration.Snapshot)
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("snapshot mode = %v, %v", fi.Mode(), err)
	}
}

// otpauth parameter names fold ASCII letters only, like the console and the
// extension: "DİGITS" (U+0130) is not "digits" anywhere.
func TestOtpauthParameterNamesFoldASCIIOnly(t *testing.T) {
	const base = "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP"
	if msg := checkTOTP(base + "&D%C4%B0GITS=9"); msg != "" {
		t.Fatalf("a non-ASCII parameter name was read as digits: %s", msg)
	}
	if msg := checkTOTP(base + "&DIGITS=9"); msg == "" {
		t.Fatal("DIGITS=9 accepted")
	}
}

// A hand-edited fields value must not break the lists that contain it.
func TestUnreadableFieldsDoNotBreakLists(t *testing.T) {
	f := newFixture(t, "alice", "root")
	ctx := t.Context()
	f.save("alice", "YQ", "a.com", "MQ", 0)
	f.save("alice", "Yg", "b.com", "Mg", 0)
	for _, bad := range []string{"", "{}", `"x"`, "not json", "[1]"} {
		mustExec(t, f.s.db, `UPDATE credentials SET fields = ? WHERE id = 'YQ'`, bad)
		creds, err := f.s.ListCredentials(ctx, f.users["alice"].ID, "")
		if err != nil || len(creds) != 2 {
			t.Fatalf("fields %q: list = %d, %v", bad, len(creds), err)
		}
		if _, _, err := f.s.ListAllCredentials(ctx, CredentialFilter{Query: "x", Limit: 10}); err != nil {
			t.Fatalf("fields %q: admin search = %v", bad, err)
		}
	}
}
