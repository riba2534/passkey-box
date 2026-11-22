package store

import (
	"errors"
	"os"
	"path/filepath"
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
	if err := rename(bob.ID, "ADMIN"); !errors.As(err, &inv) {
		t.Fatalf("renaming bob to the bootstrap name = %v", err)
	}
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

func TestPartialSchemaV1IsRefused(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pkb.db")
	writeV0Database(t, path, nil)
	mustExec(t, openRaw(t, path), `CREATE TABLE audit_log (id INTEGER PRIMARY KEY)`)
	if _, err := Open(path); err == nil || !strings.Contains(err.Error(), "part of schema 1") {
		t.Fatalf("Open = %v", err)
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
