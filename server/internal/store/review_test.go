package store

import (
	"errors"
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
