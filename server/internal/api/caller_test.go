package api_test

import (
	"net/http"
	"testing"
	"time"
)

func TestBearerTokenAuth(t *testing.T) {
	e := newEnv(t)
	alice := e.createUser("alice", "pw", false)
	secret := e.createToken(alice.ID, "claude", false, nil)
	c := e.bearer(secret)

	var me struct {
		User userJSON `json:"user"`
		Auth struct {
			Method   string `json:"method"`
			ReadOnly bool   `json:"read_only"`
			Token    *struct {
				Name     string `json:"name"`
				Prefix   string `json:"prefix"`
				ReadOnly bool   `json:"read_only"`
			} `json:"token"`
		} `json:"auth"`
	}
	c.do("GET", "/api/v1/me", nil).expect(http.StatusOK).decode(&me)
	if me.User.ID != alice.ID || me.Auth.Method != "token" || me.Auth.ReadOnly || me.Auth.Token == nil ||
		me.Auth.Token.Name != "claude" || me.Auth.Token.Prefix != secret[:12] {
		t.Fatalf("me = %+v", me)
	}
	c.do("POST", "/api/v1/credentials", newCred("YQ", "a.com", "YQ")).expect(http.StatusCreated)

	// Basic and session callers report their method and no token.
	e.basic("alice", "pw").do("GET", "/api/v1/me", nil).expect(http.StatusOK).decode(&me)
	if me.Auth.Method != "basic" || me.Auth.Token != nil {
		t.Fatalf("basic me = %+v", me.Auth)
	}
	b := e.browser()
	b.do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "pw"}).expect(http.StatusOK)
	b.do("GET", "/api/v1/me", nil).expect(http.StatusOK).decode(&me)
	if me.Auth.Method != "session" {
		t.Fatalf("session me = %+v", me.Auth)
	}

	for name, token := range map[string]string{
		"unknown":    "pkb_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"malformed":  "not-a-token",
		"empty":      "",
		"basic pass": "pw",
	} {
		t.Run(name, func(t *testing.T) {
			e.bearer(token).do("GET", "/api/v1/me", nil).expectError(http.StatusUnauthorized, "unauthorized")
		})
	}
}

func TestBearerFailureIgnoresCookie(t *testing.T) {
	e := newEnv(t)
	e.createUser("alice", "pw", false)
	b := e.browser()
	b.do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "pw"}).expect(http.StatusOK)
	b.token = "pkb_wrong"
	b.do("GET", "/api/v1/me", nil).expectError(http.StatusUnauthorized, "unauthorized")
}

func TestExpiredTokenIsRejected(t *testing.T) {
	e := newEnv(t)
	alice := e.createUser("alice", "pw", false)
	expires := e.clock().Add(time.Hour)
	secret := e.createToken(alice.ID, "short", false, &expires)
	e.bearer(secret).do("GET", "/api/v1/me", nil).expect(http.StatusOK)
	e.advance(time.Hour)
	e.bearer(secret).do("GET", "/api/v1/me", nil).expectError(http.StatusUnauthorized, "unauthorized")
}

func TestReadOnlyTokenCanOnlyRead(t *testing.T) {
	e := newEnv(t)
	alice := e.createUser("alice", "pw", false)
	e.basic("alice", "pw").do("POST", "/api/v1/credentials", newCred("YQ", "a.com", "YQ")).expect(http.StatusCreated)
	c := e.bearer(e.createToken(alice.ID, "reader", true, nil))

	c.do("GET", "/api/v1/credentials", nil).expect(http.StatusOK)
	c.do("POST", "/api/v1/credentials", newCred("Yg", "b.com", "Yg")).expectError(http.StatusForbidden, "read_only_token")
	c.do("POST", "/api/v1/credentials/YQ/use", nil).expectError(http.StatusForbidden, "read_only_token")
	c.do("PATCH", "/api/v1/credentials/YQ", map[string]string{"label": "x"}).expectError(http.StatusForbidden, "read_only_token")
	c.do("DELETE", "/api/v1/credentials/YQ", nil).expectError(http.StatusForbidden, "read_only_token")
	if n := len(e.basic("alice", "pw").do("GET", "/api/v1/credentials", nil).credentials()); n != 1 {
		t.Fatalf("credentials = %d", n)
	}
}

func TestTokensCannotManageTokensOrPassword(t *testing.T) {
	e := newEnv(t)
	alice := e.createUser("alice", "pw", false)
	c := e.bearer(e.createToken(alice.ID, "agent", false, nil))
	for _, ep := range []struct {
		method, path string
		body         any
	}{
		{"PUT", "/api/v1/me/password", map[string]string{"old_password": "pw", "new_password": "x"}},
		{"GET", "/api/v1/me/tokens", nil},
		{"POST", "/api/v1/me/tokens", map[string]any{"name": "more"}},
		{"DELETE", "/api/v1/me/tokens/1", nil},
	} {
		c.do(ep.method, ep.path, ep.body).expectError(http.StatusForbidden, "token_not_allowed")
	}
	e.basic("alice", "pw").do("GET", "/api/v1/me", nil).expect(http.StatusOK)
}

func TestAdminTokenCanCallAdminEndpoints(t *testing.T) {
	e := newEnv(t)
	root := e.createUser("root", "pw", true)
	alice := e.createUser("alice", "pw", false)
	e.bearer(e.createToken(root.ID, "ops", false, nil)).do("GET", "/api/v1/admin/users", nil).expect(http.StatusOK)
	e.bearer(e.createToken(alice.ID, "mine", false, nil)).do("GET", "/api/v1/admin/users", nil).expectError(http.StatusForbidden, "forbidden")
}

func TestDisabledUserIsLockedOut(t *testing.T) {
	e := newEnv(t)
	alice := e.createUser("alice", "pw", false)
	secret := e.createToken(alice.ID, "agent", false, nil)
	b := e.browser()
	b.do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "pw"}).expect(http.StatusOK)

	if err := e.store.SetDisabled(t.Context(), alice.ID, true); err != nil {
		t.Fatal(err)
	}
	e.basic("alice", "pw").do("GET", "/api/v1/credentials", nil).expectError(http.StatusForbidden, "account_disabled")
	e.bearer(secret).do("GET", "/api/v1/me", nil).expectError(http.StatusForbidden, "account_disabled")
	b.do("GET", "/api/v1/me", nil).expectError(http.StatusForbidden, "account_disabled")
	e.anon().do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "pw"}).expectError(http.StatusForbidden, "account_disabled")
	// A wrong password does not reveal that the account is disabled.
	e.anon().do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "nope"}).expectError(http.StatusUnauthorized, "unauthorized")
	e.basic("alice", "nope").do("GET", "/api/v1/me", nil).expectError(http.StatusUnauthorized, "unauthorized")

	if err := e.store.SetDisabled(t.Context(), alice.ID, false); err != nil {
		t.Fatal(err)
	}
	e.basic("alice", "pw").do("GET", "/api/v1/me", nil).expect(http.StatusOK)
	e.bearer(secret).do("GET", "/api/v1/me", nil).expect(http.StatusOK)
	b.do("GET", "/api/v1/me", nil).expect(http.StatusOK)
}

func TestInfoAdvertisesSkill(t *testing.T) {
	e := newEnv(t)
	var info struct {
		SkillURL string `json:"skill_url"`
	}
	e.anon().do("GET", "/api/v1/info", nil).expect(http.StatusOK).decode(&info)
	if info.SkillURL != "/skill.md" {
		t.Fatalf("skill_url = %q", info.SkillURL)
	}
}
