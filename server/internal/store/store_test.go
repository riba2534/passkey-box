package store

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

var t0 = time.Date(2026, 11, 20, 3, 30, 0, 0, time.UTC)

func openTest(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "nested", "dir", "pkb.db"))
	if err != nil {
		t.Fatal(err)
	}
	s.PasswordCost = bcrypt.MinCost
	t.Cleanup(func() { s.Close() })
	return s
}

func TestEnsureAdmin(t *testing.T) {
	ctx := t.Context()

	t.Run("creates missing user", func(t *testing.T) {
		s := openTest(t)
		created, err := s.EnsureAdmin(ctx, "admin", "first", t0)
		if err != nil || !created {
			t.Fatalf("EnsureAdmin = %v, %v", created, err)
		}
		u, err := s.Authenticate(ctx, "admin", "first")
		if err != nil || !u.IsAdmin || u.Username != "admin" {
			t.Fatalf("admin = %+v, %v", u, err)
		}
	})

	t.Run("existing user keeps password", func(t *testing.T) {
		s := openTest(t)
		if _, err := s.CreateUser(ctx, "Admin", "original", false, t0); err != nil {
			t.Fatal(err)
		}
		created, err := s.EnsureAdmin(ctx, "admin", "from-env", t0)
		if err != nil || created {
			t.Fatalf("EnsureAdmin = %v, %v", created, err)
		}
		if _, err := s.Authenticate(ctx, "admin", "from-env"); !errors.Is(err, ErrBadPassword) {
			t.Fatalf("password was replaced: %v", err)
		}
		u, err := s.Authenticate(ctx, "admin", "original")
		if err != nil || !u.IsAdmin || u.Username != "Admin" {
			t.Fatalf("admin = %+v, %v", u, err)
		}
		// Running it again is a no-op.
		if created, err := s.EnsureAdmin(ctx, "ADMIN", "other", t0); err != nil || created {
			t.Fatalf("second EnsureAdmin = %v, %v", created, err)
		}
		users, _ := s.ListUsers(ctx, UserFilter{})
		if len(users) != 1 {
			t.Fatalf("users = %+v", users)
		}
	})

	t.Run("invalid username", func(t *testing.T) {
		s := openTest(t)
		if _, err := s.EnsureAdmin(ctx, "   ", "pw", t0); err == nil {
			t.Fatal("expected an error")
		}
	})
}

func TestUsernamesAreCaseInsensitive(t *testing.T) {
	ctx := t.Context()
	s := openTest(t)
	u, err := s.CreateUser(ctx, "  Alice ", "pw", false, t0)
	if err != nil || u.Username != "Alice" {
		t.Fatalf("CreateUser = %+v, %v", u, err)
	}
	if _, err := s.CreateUser(ctx, "alice", "pw", false, t0); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate = %v, want ErrConflict", err)
	}
	if _, err := s.Authenticate(ctx, "ALICE", "pw"); err != nil {
		t.Fatalf("Authenticate = %v", err)
	}
}

func TestPersistsAcrossReopen(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "pkb.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	s.PasswordCost = bcrypt.MinCost
	u, err := s.CreateUser(ctx, "alice", "pw", false, t0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SaveCredential(ctx, SystemActor, u.ID, Credential{ID: "YQ", RPID: "a.com", UserHandle: "YQ", PrivateKey: "YQ", Alg: -7}, t0); err != nil {
		t.Fatal(err)
	}
	s.Close()

	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	got, err := s.Authenticate(ctx, "alice", "pw")
	if err != nil || got.CredentialCount != 1 {
		t.Fatalf("after reopen = %+v, %v", got, err)
	}
}

func TestDeleteUserCascades(t *testing.T) {
	ctx := t.Context()
	s := openTest(t)
	u, _ := s.CreateUser(ctx, "alice", "pw", false, t0)
	if _, err := s.SaveCredential(ctx, SystemActor, u.ID, Credential{ID: "YQ", RPID: "a.com", UserHandle: "YQ", PrivateKey: "YQ", Alg: -7}, t0); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateSession(ctx, "tok", u.ID, t0, t0.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteUser(ctx, SystemActor, u.ID, t0); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteUser(ctx, SystemActor, u.ID, t0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete = %v", err)
	}
	if _, err := s.SessionUser(ctx, "tok", t0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("session survived: %v", err)
	}
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM credentials`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("credentials left = %d, %v", n, err)
	}
}

func TestPasswordCacheFollowsPasswordChanges(t *testing.T) {
	ctx := t.Context()
	s := openTest(t)
	u, _ := s.CreateUser(ctx, "alice", "one", false, t0)
	for range 2 {
		if _, err := s.Authenticate(ctx, "alice", "one"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.UpdateUser(ctx, SystemActor, u.ID, UserUpdate{Password: new("two")}, t0); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Authenticate(ctx, "alice", "one"); !errors.Is(err, ErrBadPassword) {
		t.Fatalf("old password = %v, want ErrBadPassword", err)
	}
	if err := s.CheckPassword(ctx, u.ID, "two"); err != nil {
		t.Fatalf("new password = %v", err)
	}
}
