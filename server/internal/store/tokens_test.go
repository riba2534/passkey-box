package store

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestTokens(t *testing.T) {
	s := openTest(t)
	ctx := t.Context()
	alice, err := s.CreateUser(ctx, "alice", "pw", false, t0)
	if err != nil {
		t.Fatal(err)
	}
	bob, _ := s.CreateUser(ctx, "bob", "pw", false, t0)
	actor := Actor{ID: alice.ID, Name: "alice", Via: "session"}

	tok, secret, err := s.CreateToken(ctx, actor, alice.ID, "claude", true, nil, t0)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(secret, TokenPrefix) || len(secret) != 47 || tok.Prefix != secret[:12] || !tok.ReadOnly || tok.Name != "claude" || tok.ExpiresAt != nil || tok.LastUsedAt != nil {
		t.Fatalf("token = %+v, secret %q", tok, secret)
	}
	// Only the hash is stored.
	var stored string
	if err := s.db.QueryRow(`SELECT token_hash FROM api_tokens WHERE id = ?`, tok.ID).Scan(&stored); err != nil || strings.Contains(stored, secret[4:]) {
		t.Fatalf("stored = %q, %v", stored, err)
	}

	u, got, err := s.TokenUser(ctx, secret, t0.Add(time.Second))
	if err != nil || u.ID != alice.ID || got.ID != tok.ID || got.LastUsedAt == nil || !got.LastUsedAt.Equal(t0.Add(time.Second)) {
		t.Fatalf("TokenUser = %+v %+v %v", u, got, err)
	}
	// Uses within a minute do not rewrite last_used_at.
	if _, got, _ = s.TokenUser(ctx, secret, t0.Add(30*time.Second)); !got.LastUsedAt.Equal(t0.Add(time.Second)) {
		t.Fatalf("last_used_at = %v", got.LastUsedAt)
	}
	if _, got, _ = s.TokenUser(ctx, secret, t0.Add(2*time.Minute)); !got.LastUsedAt.Equal(t0.Add(2 * time.Minute)) {
		t.Fatalf("last_used_at = %v", got.LastUsedAt)
	}
	for _, bad := range []string{"", "pkb_", "pkb_x", secret + "x", strings.ToUpper(secret)} {
		if _, _, err := s.TokenUser(ctx, bad, t0); !errors.Is(err, ErrNotFound) {
			t.Errorf("TokenUser(%q) = %v", bad, err)
		}
	}

	exp := t0.Add(time.Hour)
	tok2, secret2, err := s.CreateToken(ctx, actor, alice.ID, "short", false, &exp, t0)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.TokenUser(ctx, secret2, exp.Add(-time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.TokenUser(ctx, secret2, exp); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired token = %v", err)
	}

	list, err := s.ListTokens(ctx, alice.ID)
	if err != nil || len(list) != 2 || list[0].ID != tok2.ID || list[1].ID != tok.ID {
		t.Fatalf("ListTokens = %+v, %v", list, err)
	}
	// Bob cannot revoke Alice's token.
	if err := s.DeleteToken(ctx, actor, bob.ID, tok.ID, t0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("DeleteToken by bob = %v", err)
	}
	if err := s.DeleteToken(ctx, actor, alice.ID, tok.ID, t0); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.TokenUser(ctx, secret, t0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoked token = %v", err)
	}

	events, err := s.ListAudit(ctx, AuditFilter{UserID: alice.ID, Action: "token.", Limit: 10})
	if err != nil || len(events) != 3 || events[0].Action != "token.revoke" || events[2].Action != "token.create" {
		t.Fatalf("events = %+v, %v", events, err)
	}
	var detail map[string]any
	if err := json.Unmarshal(events[0].Detail, &detail); err != nil || detail["name"] != "claude" || detail["read_only"] != true {
		t.Fatalf("detail = %s", events[0].Detail)
	}
	if events[0].Actor == nil || events[0].Actor.ID != alice.ID || events[0].Via != "session" || events[0].Subject.Username != "alice" {
		t.Fatalf("event = %+v", events[0])
	}
}

func TestTokenLimit(t *testing.T) {
	s := openTest(t)
	ctx := t.Context()
	u, _ := s.CreateUser(ctx, "alice", "pw", false, t0)
	for i := range MaxTokensPerUser {
		if _, _, err := s.CreateToken(ctx, SystemActor, u.ID, "t", false, nil, t0); err != nil {
			t.Fatalf("token %d: %v", i, err)
		}
	}
	var inv *InvalidError
	if _, _, err := s.CreateToken(ctx, SystemActor, u.ID, "t", false, nil, t0); !errors.As(err, &inv) {
		t.Fatalf("token over the limit = %v", err)
	}
}

func TestRevokeAccess(t *testing.T) {
	s := openTest(t)
	ctx := t.Context()
	u, _ := s.CreateUser(ctx, "alice", "pw", false, t0)
	other, _ := s.CreateUser(ctx, "bob", "pw", false, t0)
	_, secret, _ := s.CreateToken(ctx, SystemActor, u.ID, "t", false, nil, t0)
	_, otherSecret, _ := s.CreateToken(ctx, SystemActor, other.ID, "t", false, nil, t0)
	for _, tok := range []string{"s1", "s2"} {
		if err := s.CreateSession(ctx, tok, u.ID, t0, t0.Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.CreateSession(ctx, "other", other.ID, t0, t0.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	admin := Actor{ID: 99, Name: "root", Via: "token:ops"}
	sessions, tokens, err := s.RevokeAccess(ctx, admin, u.ID, t0)
	if err != nil || sessions != 2 || tokens != 1 {
		t.Fatalf("RevokeAccess = %d %d %v", sessions, tokens, err)
	}
	if _, err := s.SessionUser(ctx, "s1", t0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("session kept: %v", err)
	}
	if _, _, err := s.TokenUser(ctx, secret, t0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("token kept: %v", err)
	}
	if _, err := s.Authenticate(ctx, "alice", "pw"); err != nil {
		t.Fatalf("password changed: %v", err)
	}
	if _, err := s.SessionUser(ctx, "other", t0); err != nil {
		t.Fatalf("other user's session revoked: %v", err)
	}
	if _, _, err := s.TokenUser(ctx, otherSecret, t0); err != nil {
		t.Fatalf("other user's token revoked: %v", err)
	}
	if _, _, err := s.RevokeAccess(ctx, admin, 12345, t0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown user = %v", err)
	}
	ev, _ := s.ListAudit(ctx, AuditFilter{Action: "user.revoke_sessions", Limit: 5})
	if len(ev) != 1 || ev[0].Via != "token:ops" || ev[0].Actor.Username != "root" || ev[0].Subject.ID != u.ID {
		t.Fatalf("events = %+v", ev)
	}
}

func TestAuditFilters(t *testing.T) {
	s := openTest(t)
	ctx := t.Context()
	a := UserBrief{ID: 1, Username: "a"}
	b := UserBrief{ID: 2, Username: "b"}
	write := func(action string, actor Actor, subject, target *UserBrief, cred *AuditCredential) {
		if err := writeAudit(ctx, s.db, t0, actor, AuditEntry{Action: action, Subject: subject, Target: target, Credential: cred}); err != nil {
			t.Fatal(err)
		}
	}
	write("credential.share", Actor{ID: 1, Name: "a", Via: "session"}, &a, &b, &AuditCredential{ID: "YQ", RPID: "x.com", UserName: "me"})
	write("credential.transfer", Actor{ID: 3, Name: "root", Via: "basic"}, &a, &b, &AuditCredential{ID: "Yg"})
	write("user.create", SystemActor, &b, nil, nil)
	write("credentials.other", SystemActor, nil, nil, nil)

	ids := func(f AuditFilter) []string {
		f.Limit = 10
		ev, err := s.ListAudit(ctx, f)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, e := range ev {
			out = append(out, e.Action)
		}
		return out
	}
	check := func(name string, f AuditFilter, want ...string) {
		t.Helper()
		if got := ids(f); strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("%s: got %v, want %v", name, got, want)
		}
	}
	check("all", AuditFilter{}, "credentials.other", "user.create", "credential.transfer", "credential.share")
	check("user a", AuditFilter{UserID: 1}, "credential.transfer", "credential.share")
	check("user b", AuditFilter{UserID: 2}, "user.create", "credential.transfer", "credential.share")
	check("actor root", AuditFilter{ActorID: 3}, "credential.transfer")
	check("prefix", AuditFilter{Action: "credential."}, "credential.transfer", "credential.share")
	check("exact", AuditFilter{Action: "user.create"}, "user.create")
	check("credential", AuditFilter{CredentialID: "YQ"}, "credential.share")
	check("before", AuditFilter{Before: 3}, "credential.transfer", "credential.share")

	ev, _ := s.ListAudit(ctx, AuditFilter{Action: "user.create", Limit: 1})
	if ev[0].Actor != nil || ev[0].Via != "system" || ev[0].Target != nil || ev[0].Credential != nil || string(ev[0].Detail) != "{}" {
		t.Fatalf("system event = %+v", ev[0])
	}
	ev, _ = s.ListAudit(ctx, AuditFilter{CredentialID: "YQ", Limit: 1})
	if c := ev[0].Credential; c == nil || c.RPID != "x.com" || c.UserName != "me" || ev[0].Target.Username != "b" {
		t.Fatalf("share event = %+v", ev[0])
	}
}
