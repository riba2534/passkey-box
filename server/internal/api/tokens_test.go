package api_test

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/riba2534/passkey-box/server/internal/store"
)

type tokenJSON struct {
	ID         int64   `json:"id"`
	Name       string  `json:"name"`
	Prefix     string  `json:"prefix"`
	ReadOnly   bool    `json:"read_only"`
	CreatedAt  string  `json:"created_at"`
	ExpiresAt  *string `json:"expires_at"`
	LastUsedAt *string `json:"last_used_at"`
}

type newTokenJSON struct {
	Token  tokenJSON `json:"token"`
	Secret string    `json:"secret"`
}

func TestTokenEndpoints(t *testing.T) {
	e := newEnv(t)
	alice := e.createUser("alice", "pw", false)
	bob := e.createUser("bob", "pw", false)
	b := e.browser()
	b.do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "pw"}).expect(http.StatusOK)

	var claude newTokenJSON
	b.do("POST", "/api/v1/me/tokens", map[string]any{"name": "  claude  ", "read_only": true, "expires_in_days": 90}).
		expect(http.StatusCreated).decode(&claude)
	if tok := claude.Token; tok.Name != "claude" || !tok.ReadOnly || tok.Prefix != claude.Secret[:12] || len(claude.Secret) != 47 ||
		tok.CreatedAt != "2026-11-20T03:30:00Z" || tok.ExpiresAt == nil || *tok.ExpiresAt != "2027-02-18T03:30:00Z" || tok.LastUsedAt != nil {
		t.Fatalf("token = %+v", claude)
	}
	var me struct {
		User userJSON `json:"user"`
		Auth struct {
			ReadOnly bool `json:"read_only"`
		} `json:"auth"`
	}
	e.bearer(claude.Secret).do("GET", "/api/v1/me", nil).expect(http.StatusOK).decode(&me)
	if me.User.ID != alice.ID || !me.Auth.ReadOnly {
		t.Fatalf("me = %+v", me)
	}

	// Basic callers may manage tokens too; omitting the lifetime never expires.
	var ci newTokenJSON
	e.basic("alice", "pw").do("POST", "/api/v1/me/tokens", map[string]any{"name": "ci", "expires_in_days": nil}).expect(http.StatusCreated).decode(&ci)
	if ci.Token.ExpiresAt != nil || ci.Token.ReadOnly {
		t.Fatalf("ci = %+v", ci)
	}

	r := b.do("GET", "/api/v1/me/tokens", nil).expect(http.StatusOK)
	var list struct {
		Tokens []tokenJSON `json:"tokens"`
	}
	r.decode(&list)
	if len(list.Tokens) != 2 || list.Tokens[0].ID != ci.Token.ID || list.Tokens[1].ID != claude.Token.ID || list.Tokens[1].LastUsedAt == nil {
		t.Fatalf("tokens = %+v", list.Tokens)
	}
	if strings.Contains(string(r.body), claude.Secret) || strings.Contains(string(r.body), "secret") {
		t.Fatalf("list reveals secrets: %s", r.body)
	}
	// Other users' tokens are not listed.
	e.createToken(bob.ID, "bob's", false, nil)
	if n := strings.Count(string(e.basic("bob", "pw").do("GET", "/api/v1/me/tokens", nil).expect(http.StatusOK).body), `"id"`); n != 1 {
		t.Fatalf("bob sees %d tokens", n)
	}

	for name, body := range map[string]any{
		"not JSON":      "nope",
		"no name":       map[string]any{},
		"blank name":    map[string]any{"name": "   "},
		"long name":     map[string]any{"name": strings.Repeat("x", 65)},
		"zero days":     map[string]any{"name": "x", "expires_in_days": 0},
		"too many days": map[string]any{"name": "x", "expires_in_days": 3651},
		"partial days":  map[string]any{"name": "x", "expires_in_days": 1.5},
	} {
		t.Run(name, func(t *testing.T) {
			b.do("POST", "/api/v1/me/tokens", body).expectError(http.StatusBadRequest, "invalid_request")
		})
	}
	b.do("POST", "/api/v1/me/tokens", map[string]any{"name": strings.Repeat("令", 64), "expires_in_days": 3650}).expect(http.StatusCreated)
	b.do("POST", "/api/v1/me/tokens", map[string]any{"name": "short", "expires_in_days": 1}).expect(http.StatusCreated)

	bobTokens, _ := e.store.ListTokens(t.Context(), bob.ID)
	for _, id := range []string{fmt.Sprint(bobTokens[0].ID), "999", "abc"} {
		b.do("DELETE", "/api/v1/me/tokens/"+id, nil).expectError(http.StatusNotFound, "not_found")
	}
	b.do("DELETE", fmt.Sprintf("/api/v1/me/tokens/%d", claude.Token.ID), nil).expect(http.StatusNoContent)
	b.do("DELETE", fmt.Sprintf("/api/v1/me/tokens/%d", claude.Token.ID), nil).expectError(http.StatusNotFound, "not_found")
	e.bearer(claude.Secret).do("GET", "/api/v1/me", nil).expectError(http.StatusUnauthorized, "unauthorized")

	ev := e.events(store.AuditFilter{ActorID: alice.ID, Action: "token."})
	if len(ev) != 5 || ev[0].Action != "token.revoke" || ev[0].Via != "session" || ev[0].Subject.ID != alice.ID ||
		string(ev[0].Detail) != `{"name":"claude","read_only":true}` || ev[3].Via != "basic" {
		t.Fatalf("events = %+v", ev)
	}
}

func TestTokenLimit(t *testing.T) {
	e := newEnv(t)
	alice := e.createUser("alice", "pw", false)
	for range store.MaxTokensPerUser {
		e.createToken(alice.ID, "t", false, nil)
	}
	e.basic("alice", "pw").do("POST", "/api/v1/me/tokens", map[string]any{"name": "one more"}).expectError(http.StatusBadRequest, "invalid_request")
}
