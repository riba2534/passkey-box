package api_test

import (
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestCredentialCRUD(t *testing.T) {
	e := newEnv(t)
	e.createUser("alice", "pw", false)
	c := e.basic("alice", "pw")

	r := c.do("GET", "/api/v1/credentials", nil).expect(http.StatusOK)
	if got := strings.TrimSpace(string(r.body)); got != `{"credentials":[]}` {
		t.Fatalf("empty list = %s", got)
	}

	body := newCred("Y3JlZC0x", "github.com", "dXNlci0x")
	body["rp_name"] = "GitHub"
	body["label"] = "work"
	created := c.do("POST", "/api/v1/credentials", body).expect(http.StatusCreated).credential()
	want := credJSON{
		ID: "Y3JlZC0x", RPID: "github.com", RPName: "GitHub", UserHandle: "dXNlci0x",
		UserName: "alice@example.com", UserDisplayName: "Alice", Alg: -7,
		PrivateKey: "cHJpdmF0ZS1rZXk", PublicKey: "cHVibGljLWtleQ", Label: "work",
		Origin: "https://github.com", CreatedAt: "2026-11-20T03:30:00Z",
	}
	if created != want {
		t.Fatalf("created = %+v\nwant      %+v", created, want)
	}
	if !strings.Contains(string(c.do("GET", "/api/v1/credentials", nil).body), `"last_used_at":null`) {
		t.Fatal("last_used_at must be null before first use")
	}

	// Optional fields default to empty strings; RS256 is accepted.
	minimal := map[string]any{"id": "Y3JlZC0y", "rp_id": "example.org", "user_handle": "dXNlci0y", "private_key": "a2V5", "alg": -257}
	m := c.do("POST", "/api/v1/credentials", minimal).expect(http.StatusCreated).credential()
	if m.Alg != -257 || m.RPName != "" || m.UserName != "" || m.PublicKey != "" || m.Label != "" || m.Origin != "" {
		t.Fatalf("minimal = %+v", m)
	}

	list := c.do("GET", "/api/v1/credentials", nil).expect(http.StatusOK).credentials()
	if len(list) != 2 {
		t.Fatalf("list = %v", credIDs(list))
	}

	updated := c.do("PATCH", "/api/v1/credentials/Y3JlZC0x", map[string]string{"label": "工作号"}).expect(http.StatusOK).credential()
	if updated.Label != "工作号" || updated.UserName != "alice@example.com" {
		t.Fatalf("updated = %+v", updated)
	}
	c.do("PATCH", "/api/v1/credentials/Y3JlZC0x", map[string]string{}).expectError(http.StatusBadRequest, "invalid_request")
	c.do("PATCH", "/api/v1/credentials/missing", map[string]string{"label": "x"}).expectError(http.StatusNotFound, "not_found")

	c.do("DELETE", "/api/v1/credentials/Y3JlZC0x", nil).expect(http.StatusNoContent)
	c.do("DELETE", "/api/v1/credentials/Y3JlZC0x", nil).expectError(http.StatusNotFound, "not_found")
	c.do("POST", "/api/v1/credentials/Y3JlZC0x/use", nil).expectError(http.StatusNotFound, "not_found")
	if ids := credIDs(c.do("GET", "/api/v1/credentials", nil).credentials()); !slices.Equal(ids, []string{"Y3JlZC0y"}) {
		t.Fatalf("after delete = %v", ids)
	}

	e.anon().do("GET", "/api/v1/credentials", nil).expectError(http.StatusUnauthorized, "unauthorized")
	e.anon().do("POST", "/api/v1/credentials", newCred("Y3JlZC0z", "a.com", "dQ")).expectError(http.StatusUnauthorized, "unauthorized")
}

func TestCreateCredentialValidation(t *testing.T) {
	e := newEnv(t)
	e.createUser("alice", "pw", false)
	c := e.basic("alice", "pw")

	cases := map[string]func(map[string]any){
		"missing id":          func(b map[string]any) { delete(b, "id") },
		"missing rp_id":       func(b map[string]any) { b["rp_id"] = " " },
		"missing user_handle": func(b map[string]any) { delete(b, "user_handle") },
		"missing private_key": func(b map[string]any) { b["private_key"] = "" },
		"missing alg":         func(b map[string]any) { delete(b, "alg") },
		"unsupported alg":     func(b map[string]any) { b["alg"] = -8 },
		"padded id":           func(b map[string]any) { b["id"] = "YQ==" },
		"non-base64url id":    func(b map[string]any) { b["id"] = "a+b/" },
		"bad user_handle":     func(b map[string]any) { b["user_handle"] = "not base64!" },
		"bad public_key":      func(b map[string]any) { b["public_key"] = "%%%" },
		"wrong type":          func(b map[string]any) { b["rp_name"] = 42 },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			body := newCred("Y3JlZA", "example.com", "dXNlcg")
			mutate(body)
			c.do("POST", "/api/v1/credentials", body).expectError(http.StatusBadRequest, "invalid_request")
		})
	}
	c.do("POST", "/api/v1/credentials", "{").expectError(http.StatusBadRequest, "invalid_request")
	if n := len(c.do("GET", "/api/v1/credentials", nil).credentials()); n != 0 {
		t.Fatalf("invalid requests stored %d credentials", n)
	}
}

func TestCreateCredentialReplacesSameAccount(t *testing.T) {
	e := newEnv(t)
	e.createUser("alice", "pw", false)
	c := e.basic("alice", "pw")

	c.do("POST", "/api/v1/credentials", newCred("b2xk", "github.com", "aGFuZGxl")).expect(http.StatusCreated)
	c.do("POST", "/api/v1/credentials/b2xk/use", nil).expect(http.StatusNoContent)
	// Other accounts and other sites must survive the overwrite.
	c.do("POST", "/api/v1/credentials", newCred("b3RoZXI", "github.com", "b3RoZXI")).expect(http.StatusCreated)
	c.do("POST", "/api/v1/credentials", newCred("c2l0ZQ", "gitlab.com", "aGFuZGxl")).expect(http.StatusCreated)

	e.advance(time.Minute)
	fresh := c.do("POST", "/api/v1/credentials", newCred("bmV3", "GitHub.COM", "aGFuZGxl")).expect(http.StatusCreated).credential()
	if fresh.UseCount != 0 || fresh.LastUsedAt != nil || fresh.CreatedAt != "2026-11-20T03:31:00Z" {
		t.Fatalf("replacement = %+v", fresh)
	}

	ids := credIDs(c.do("GET", "/api/v1/credentials", nil).credentials())
	slices.Sort(ids)
	if want := []string{"b3RoZXI", "bmV3", "c2l0ZQ"}; !slices.Equal(ids, want) {
		t.Fatalf("credentials = %v, want %v", ids, want)
	}
	c.do("DELETE", "/api/v1/credentials/b2xk", nil).expectError(http.StatusNotFound, "not_found")

	// Re-registering with the very same ID for the same account is an overwrite, not a conflict.
	c.do("POST", "/api/v1/credentials", newCred("bmV3", "github.com", "aGFuZGxl")).expect(http.StatusCreated)
	if n := len(c.do("GET", "/api/v1/credentials?rp_id=github.com", nil).credentials()); n != 2 {
		t.Fatalf("github.com credentials = %d, want 2", n)
	}
}

func TestCreateCredentialDuplicateID(t *testing.T) {
	e := newEnv(t)
	e.createUser("alice", "pw", false)
	c := e.basic("alice", "pw")

	c.do("POST", "/api/v1/credentials", newCred("ZHVw", "github.com", "b25l")).expect(http.StatusCreated)
	c.do("POST", "/api/v1/credentials", newCred("dmljdGlt", "example.com", "dHdv")).expect(http.StatusCreated)

	// Same ID, different account: conflict. The overwrite step must be rolled
	// back, so dmljdGlt (same rp_id/user_handle as the request) survives.
	c.do("POST", "/api/v1/credentials", newCred("ZHVw", "example.com", "dHdv")).expectError(http.StatusConflict, "conflict")
	ids := credIDs(c.do("GET", "/api/v1/credentials", nil).credentials())
	slices.Sort(ids)
	if want := []string{"ZHVw", "dmljdGlt"}; !slices.Equal(ids, want) {
		t.Fatalf("credentials = %v, want %v", ids, want)
	}
}

func TestListCredentialsRPIDFilterIsCaseInsensitive(t *testing.T) {
	e := newEnv(t)
	e.createUser("alice", "pw", false)
	c := e.basic("alice", "pw")
	c.do("POST", "/api/v1/credentials", newCred("Z2g", "GitHub.com", "MQ")).expect(http.StatusCreated)
	c.do("POST", "/api/v1/credentials", newCred("Z2gy", "github.com", "Mg")).expect(http.StatusCreated)
	c.do("POST", "/api/v1/credentials", newCred("c3Vi", "gist.github.com", "Mw")).expect(http.StatusCreated)

	tests := map[string][]string{
		"github.com":      {"Z2gy", "Z2g"},
		"GITHUB.COM":      {"Z2gy", "Z2g"},
		"Gist.GitHub.com": {"c3Vi"},
		"hub.com":         {},
		"":                {"c3Vi", "Z2gy", "Z2g"},
	}
	for rpID, want := range tests {
		got := credIDs(c.do("GET", "/api/v1/credentials?rp_id="+rpID, nil).expect(http.StatusOK).credentials())
		if !slices.Equal(got, want) {
			t.Errorf("rp_id=%q: got %v, want %v", rpID, got, want)
		}
	}
	// The original spelling of rp_id is kept.
	if got := c.do("GET", "/api/v1/credentials?rp_id=github.com", nil).credentials()[1].RPID; got != "GitHub.com" {
		t.Errorf("rp_id = %q, want GitHub.com", got)
	}
}

func TestListCredentialsNewestFirst(t *testing.T) {
	e := newEnv(t)
	e.createUser("alice", "pw", false)
	c := e.basic("alice", "pw")
	for i, id := range []string{"YQ", "Yg", "Yw"} {
		if i == 1 {
			e.advance(time.Hour)
		}
		c.do("POST", "/api/v1/credentials", newCred(id, "example.com", id)).expect(http.StatusCreated)
	}
	got := credIDs(c.do("GET", "/api/v1/credentials", nil).credentials())
	if want := []string{"Yw", "Yg", "YQ"}; !slices.Equal(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
}

func TestCredentialsAreIsolatedBetweenUsers(t *testing.T) {
	e := newEnv(t)
	e.createUser("alice", "pw", false)
	e.createUser("bob", "pw", false)
	alice, bob := e.basic("alice", "pw"), e.basic("bob", "pw")

	alice.do("POST", "/api/v1/credentials", newCred("YWxpY2U", "github.com", "YQ")).expect(http.StatusCreated)

	if n := len(bob.do("GET", "/api/v1/credentials", nil).expect(http.StatusOK).credentials()); n != 0 {
		t.Fatalf("bob sees %d credentials", n)
	}
	if n := len(bob.do("GET", "/api/v1/credentials?rp_id=github.com", nil).credentials()); n != 0 {
		t.Fatalf("bob sees %d github.com credentials", n)
	}
	bob.do("PATCH", "/api/v1/credentials/YWxpY2U", map[string]string{"label": "mine"}).expectError(http.StatusNotFound, "not_found")
	bob.do("POST", "/api/v1/credentials/YWxpY2U/use", nil).expectError(http.StatusNotFound, "not_found")
	bob.do("DELETE", "/api/v1/credentials/YWxpY2U", nil).expectError(http.StatusNotFound, "not_found")

	// IDs are unique per user only, and bob registering the same account on
	// the same site must not overwrite alice's credential.
	bob.do("POST", "/api/v1/credentials", newCred("YWxpY2U", "github.com", "YQ")).expect(http.StatusCreated)
	bob.do("DELETE", "/api/v1/credentials/YWxpY2U", nil).expect(http.StatusNoContent)

	list := alice.do("GET", "/api/v1/credentials", nil).credentials()
	if len(list) != 1 || list[0].Label != "" || list[0].UseCount != 0 {
		t.Fatalf("alice's credentials changed: %+v", list)
	}
}

func TestUseCredentialUpdatesStats(t *testing.T) {
	e := newEnv(t)
	e.createUser("alice", "pw", false)
	c := e.basic("alice", "pw")
	c.do("POST", "/api/v1/credentials", newCred("dXNl", "example.com", "dQ")).expect(http.StatusCreated)
	c.do("POST", "/api/v1/credentials", newCred("aWRsZQ", "example.com", "dg")).expect(http.StatusCreated)

	e.advance(10 * time.Minute)
	c.do("POST", "/api/v1/credentials/dXNl/use", nil).expect(http.StatusNoContent)
	e.advance(5 * time.Minute)
	c.do("POST", "/api/v1/credentials/dXNl/use", nil).expect(http.StatusNoContent)

	for _, cr := range c.do("GET", "/api/v1/credentials", nil).credentials() {
		switch cr.ID {
		case "dXNl":
			if cr.UseCount != 2 || cr.LastUsedAt == nil || *cr.LastUsedAt != "2026-11-20T03:45:00Z" {
				t.Fatalf("used credential = %+v", cr)
			}
		case "aWRsZQ":
			if cr.UseCount != 0 || cr.LastUsedAt != nil {
				t.Fatalf("idle credential = %+v", cr)
			}
		}
	}
}

func TestUserStatistics(t *testing.T) {
	e := newEnv(t)
	e.createUser("admin", "pw", true)
	e.createUser("alice", "pw", false)
	alice := e.basic("alice", "pw")

	me := alice.do("GET", "/api/v1/me", nil).user()
	if me.CredentialCount != 0 || me.LastUsedAt != nil {
		t.Fatalf("fresh stats = %+v", me)
	}

	for _, id := range []string{"YQ", "Yg", "Yw"} {
		alice.do("POST", "/api/v1/credentials", newCred(id, "example.com", id)).expect(http.StatusCreated)
	}
	e.advance(time.Hour)
	alice.do("POST", "/api/v1/credentials/YQ/use", nil).expect(http.StatusNoContent)
	e.advance(time.Hour)
	alice.do("POST", "/api/v1/credentials/Yg/use", nil).expect(http.StatusNoContent)

	me = alice.do("GET", "/api/v1/me", nil).user()
	if me.CredentialCount != 3 || me.LastUsedAt == nil || *me.LastUsedAt != "2026-11-20T05:30:00Z" {
		t.Fatalf("stats = %+v", me)
	}

	alice.do("DELETE", "/api/v1/credentials/Yw", nil).expect(http.StatusNoContent)
	users := e.basic("admin", "pw").do("GET", "/api/v1/admin/users", nil).expect(http.StatusOK).users()
	if len(users) != 2 {
		t.Fatalf("users = %+v", users)
	}
	if users[0].CredentialCount != 0 || users[0].LastUsedAt != nil {
		t.Fatalf("admin stats = %+v", users[0])
	}
	if users[1].CredentialCount != 2 || users[1].LastUsedAt == nil || *users[1].LastUsedAt != "2026-11-20T05:30:00Z" {
		t.Fatalf("alice stats = %+v", users[1])
	}
}
