package api_test

import (
	"fmt"
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
		"javascript origin":   func(b map[string]any) { b["origin"] = "javascript:alert(1)" },
		"data origin":         func(b map[string]any) { b["origin"] = "data:text/html,hi" },
		"ftp origin":          func(b map[string]any) { b["origin"] = "ftp://example.com" },
		"relative origin":     func(b map[string]any) { b["origin"] = "example.com" },
		"hostless origin":     func(b map[string]any) { b["origin"] = "https://" },
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

func TestCreateCredentialAcceptsHTTPOrigins(t *testing.T) {
	e := newEnv(t)
	e.createUser("alice", "pw", false)
	c := e.basic("alice", "pw")
	for i, origin := range []string{"", "https://example.com", "http://localhost:18421", "HTTPS://Example.COM"} {
		body := newCred(fmt.Sprintf("b3JpZ%d", i), "example.com", fmt.Sprintf("dQ%d", i))
		body["origin"] = origin
		if got := c.do("POST", "/api/v1/credentials", body).expect(http.StatusCreated).credential(); got.Origin != origin {
			t.Errorf("origin = %q, want %q", got.Origin, origin)
		}
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

	// IDs are unique across users, and bob registering the same account on
	// the same site must not overwrite alice's credential.
	bob.do("POST", "/api/v1/credentials", newCred("YWxpY2U", "github.com", "YQ")).expectError(http.StatusConflict, "conflict")
	bob.do("POST", "/api/v1/credentials", newCred("Ym9i", "github.com", "YQ")).expect(http.StatusCreated)
	bob.do("DELETE", "/api/v1/credentials/Ym9i", nil).expect(http.StatusNoContent)

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

// accessJSON is the sharing part of a credential in a user's list.
type accessJSON struct {
	ID         string     `json:"id"`
	Label      string     `json:"label"`
	UseCount   int64      `json:"use_count"`
	LastUsedAt *string    `json:"last_used_at"`
	Owner      *briefJSON `json:"owner"`
	Access     *string    `json:"access"`
	SharedAt   *string    `json:"shared_at"`
	SharedWith *[]struct {
		User       briefJSON  `json:"user"`
		SharedAt   string     `json:"shared_at"`
		SharedBy   *briefJSON `json:"shared_by"`
		LastUsedAt *string    `json:"last_used_at"`
	} `json:"shared_with"`
}

func (r *response) accessCredential() accessJSON {
	r.t.Helper()
	var body struct {
		Credential accessJSON `json:"credential"`
	}
	r.expect(http.StatusOK).decode(&body)
	return body.Credential
}

func (r *response) accessCredentials() []accessJSON {
	r.t.Helper()
	var body struct {
		Credentials []accessJSON `json:"credentials"`
	}
	r.expect(http.StatusOK).decode(&body)
	return body.Credentials
}

func TestGetCredential(t *testing.T) {
	w := newWorld(t)
	w.register("alice", "YQ", "a.com", "MQ")
	w.advance(time.Minute)
	w.shareWith("alice", "YQ", "bob")

	own := w.as("alice").do("GET", "/api/v1/credentials/YQ", nil).accessCredential()
	if own.ID != "YQ" || *own.Access != "owner" || own.SharedAt != nil || *own.Owner != brief(w.alice) ||
		own.SharedWith == nil || len(*own.SharedWith) != 1 {
		t.Fatalf("owner view = %+v", own)
	}
	sw := (*own.SharedWith)[0]
	if sw.User != brief(w.bob) || sw.SharedAt != "2026-11-20T03:31:00Z" || *sw.SharedBy != brief(w.alice) || sw.LastUsedAt != nil {
		t.Fatalf("share = %+v", sw)
	}
	shared := w.as("bob").do("GET", "/api/v1/credentials/YQ", nil).accessCredential()
	if *shared.Access != "shared" || *shared.SharedAt != "2026-11-20T03:31:00Z" || *shared.Owner != brief(w.alice) || shared.SharedWith != nil {
		t.Fatalf("recipient view = %+v", shared)
	}
	w.as("carol").do("GET", "/api/v1/credentials/YQ", nil).expectError(http.StatusNotFound, "not_found")
	w.as("alice").do("GET", "/api/v1/credentials/bm9uZQ", nil).expectError(http.StatusNotFound, "not_found")
	w.anon().do("GET", "/api/v1/credentials/YQ", nil).expectError(http.StatusUnauthorized, "unauthorized")
}

func TestListCredentialsAccessFilter(t *testing.T) {
	w := newWorld(t)
	w.register("alice", "YQ", "a.com", "MQ")
	w.register("bob", "Yg", "A.com", "Mg")
	w.register("bob", "Yw", "b.com", "Mw")
	w.shareWith("bob", "Yg", "alice")
	w.shareWith("bob", "Yw", "alice")
	alice := w.as("alice")
	for query, want := range map[string][]string{
		"":                           {"Yw", "Yg", "YQ"},
		"?access=all":                {"Yw", "Yg", "YQ"},
		"?access=owned":              {"YQ"},
		"?access=shared":             {"Yw", "Yg"},
		"?access=shared&rp_id=a.COM": {"Yg"},
		"?access=owned&rp_id=b.com":  {},
	} {
		if got := listIDs(alice, "/api/v1/credentials"+query); !slices.Equal(got, want) {
			t.Errorf("%s: got %v, want %v", query, got, want)
		}
	}
	alice.do("GET", "/api/v1/credentials?access=mine", nil).expectError(http.StatusBadRequest, "invalid_request")
}

func TestSharedCredentialRules(t *testing.T) {
	w := newWorld(t)
	w.register("alice", "YQ", "a.com", "MQ")
	w.shareWith("alice", "YQ", "bob", "carol")
	bob := w.as("bob")

	// Recipients may use the credential; the use counts on the credential, on
	// the share and not on the recipient's own statistics.
	w.advance(time.Hour)
	bob.do("POST", "/api/v1/credentials/YQ/use", nil).expect(http.StatusNoContent)
	w.advance(time.Hour)
	w.as("alice").do("POST", "/api/v1/credentials/YQ/use", nil).expect(http.StatusNoContent)
	own := w.as("alice").do("GET", "/api/v1/credentials/YQ", nil).accessCredential()
	shares := *own.SharedWith
	if own.UseCount != 2 || *own.LastUsedAt != "2026-11-20T05:30:00Z" || shares[0].User != brief(w.bob) ||
		shares[0].LastUsedAt == nil || *shares[0].LastUsedAt != "2026-11-20T04:30:00Z" || shares[1].LastUsedAt != nil {
		t.Fatalf("after use = %+v", own)
	}
	if me := bob.do("GET", "/api/v1/me", nil).user(); me.CredentialCount != 0 || me.LastUsedAt != nil {
		t.Fatalf("bob's stats = %+v", me)
	}

	// Only the owner changes the label.
	bob.do("PATCH", "/api/v1/credentials/YQ", map[string]string{"label": "mine"}).expectError(http.StatusForbidden, "forbidden")
	bob.do("PATCH", "/api/v1/credentials/YQ", map[string]string{}).expectError(http.StatusBadRequest, "invalid_request")
	if got := w.as("alice").do("PATCH", "/api/v1/credentials/YQ", map[string]string{"label": "team"}).accessCredential(); got.Label != "team" || got.SharedWith == nil {
		t.Fatalf("owner relabel = %+v", got)
	}

	// A recipient's DELETE leaves the share; the owner keeps the credential.
	bob.do("DELETE", "/api/v1/credentials/YQ", nil).expect(http.StatusNoContent)
	bob.do("DELETE", "/api/v1/credentials/YQ", nil).expectError(http.StatusNotFound, "not_found")
	bob.do("POST", "/api/v1/credentials/YQ/use", nil).expectError(http.StatusNotFound, "not_found")
	if got := listIDs(bob, "/api/v1/credentials"); len(got) != 0 {
		t.Fatalf("bob still sees %v", got)
	}
	if got := w.as("alice").do("GET", "/api/v1/credentials/YQ", nil).accessCredential(); len(*got.SharedWith) != 1 || (*got.SharedWith)[0].User != brief(w.carol) {
		t.Fatalf("after bob left = %+v", got)
	}

	// The owner's DELETE removes the credential for everyone.
	w.as("alice").do("DELETE", "/api/v1/credentials/YQ", nil).expect(http.StatusNoContent)
	if got := listIDs(w.as("carol"), "/api/v1/credentials"); len(got) != 0 {
		t.Fatalf("carol still sees %v", got)
	}
	var actions []string
	for _, e := range w.audit("credential.")[:3] {
		actions = append(actions, fmt.Sprintf("%s:%s>%v", e.Action, e.Actor.Username, e.Target))
	}
	if !slices.Equal(actions, []string{"credential.delete:alice><nil>", "credential.leave:bob>&{" + fmt.Sprint(w.bob.ID) + " bob}", "credential.update:alice><nil>"}) {
		t.Fatalf("events = %v", actions)
	}
}

func TestReRegisteringKeepsShares(t *testing.T) {
	w := newWorld(t)
	w.register("alice", "b2xk", "github.com", "aGFuZGxl")
	w.shareWith("alice", "b2xk", "bob")
	w.as("bob").do("POST", "/api/v1/credentials/b2xk/use", nil).expect(http.StatusNoContent)
	// Bob's own credential for the same account stays his.
	w.register("bob", "Ym9i", "GitHub.com", "aGFuZGxl")

	w.advance(time.Minute)
	created := w.as("alice").do("POST", "/api/v1/credentials", newCred("bmV3", "GITHUB.com", "aGFuZGxl")).expect(http.StatusCreated)
	var body struct {
		Credential accessJSON `json:"credential"`
	}
	created.decode(&body)
	if c := body.Credential; c.ID != "bmV3" || *c.Access != "owner" || len(*c.SharedWith) != 1 ||
		(*c.SharedWith)[0].User != brief(w.bob) || (*c.SharedWith)[0].SharedAt != "2026-11-20T03:30:00Z" || (*c.SharedWith)[0].LastUsedAt == nil {
		t.Fatalf("replacement = %+v", c)
	}
	if got := listIDs(w.as("bob"), "/api/v1/credentials?rp_id=github.com"); !slices.Equal(got, []string{"bmV3", "Ym9i"}) {
		t.Fatalf("bob's credentials = %v", got)
	}
	w.as("bob").do("GET", "/api/v1/credentials/b2xk", nil).expectError(http.StatusNotFound, "not_found")
	ev := w.audit("credential.create")
	if len(ev) != 3 || ev[0].Credential.ID != "bmV3" || ev[0].Subject.Username != "alice" || ev[0].Via != "basic" {
		t.Fatalf("create events = %+v", ev)
	}
}

func TestDeletingUsersRemovesTheirShares(t *testing.T) {
	w := newWorld(t)
	w.register("alice", "YQ", "a.com", "MQ")
	w.register("carol", "Yw", "c.com", "Mw")
	w.shareWith("alice", "YQ", "bob", "carol")
	w.shareWith("carol", "Yw", "alice", "bob")
	root := w.as("root")

	root.do("DELETE", fmt.Sprintf("/api/v1/admin/users/%d", w.bob.ID), nil).expect(http.StatusNoContent)
	if got := w.as("alice").do("GET", "/api/v1/credentials/YQ", nil).accessCredential(); len(*got.SharedWith) != 1 || (*got.SharedWith)[0].User != brief(w.carol) {
		t.Fatalf("shares after deleting bob = %+v", got.SharedWith)
	}
	// Deleting an owner deletes the credential for its recipients too.
	root.do("DELETE", fmt.Sprintf("/api/v1/admin/users/%d", w.carol.ID), nil).expect(http.StatusNoContent)
	if got := listIDs(w.as("alice"), "/api/v1/credentials"); !slices.Equal(got, []string{"YQ"}) {
		t.Fatalf("alice after deleting carol = %v", got)
	}
	if got := w.as("alice").do("GET", "/api/v1/credentials/YQ", nil).accessCredential(); len(*got.SharedWith) != 0 {
		t.Fatalf("shares after deleting carol = %+v", got.SharedWith)
	}
}

func TestCredentialChangesAreAudited(t *testing.T) {
	w := newWorld(t)
	b := w.browser()
	b.do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "pw"}).expect(http.StatusOK)
	token := w.bearer(w.createToken(w.alice.ID, "claude", false, nil))

	b.do("POST", "/api/v1/credentials", newCred("YQ", "a.com", "MQ")).expect(http.StatusCreated)
	token.do("PATCH", "/api/v1/credentials/YQ", map[string]string{"label": "work"}).expect(http.StatusOK)
	// An unchanged label is not an event.
	token.do("PATCH", "/api/v1/credentials/YQ", map[string]string{"label": "work"}).expect(http.StatusOK)
	w.as("alice").do("POST", "/api/v1/credentials/YQ/use", nil).expect(http.StatusNoContent)
	w.as("alice").do("DELETE", "/api/v1/credentials/YQ", nil).expect(http.StatusNoContent)

	ev := w.audit("credential.")
	var got []string
	for _, e := range ev {
		got = append(got, fmt.Sprintf("%s via %s by %s on %s %s/%s %s", e.Action, e.Via, e.Actor.Username, e.Subject.Username,
			e.Credential.ID, e.Credential.RPID, e.Detail))
	}
	want := []string{
		"credential.delete via basic by alice on alice YQ/a.com {}",
		`credential.update via token:claude by alice on alice YQ/a.com {"label":{"from":"","to":"work"}}`,
		"credential.create via session by alice on alice YQ/a.com {}",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("events =\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if ev[0].Credential.UserName != "alice@example.com" || ev[0].Target != nil {
		t.Fatalf("delete event = %+v", ev[0])
	}
}

// private_key is only sent to HTTP Basic callers of the four user endpoints
// that return full credentials, to owners and recipients alike.
func TestPrivateKeyVisibility(t *testing.T) {
	w := newWorld(t)
	w.register("bob", "Ym9i", "b.com", "Yg")
	w.shareWith("bob", "Ym9i", "alice")
	session := w.browser()
	session.do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "pw"}).expect(http.StatusOK)
	callers := map[string]*client{
		"basic":   w.as("alice"),
		"session": session,
		"token":   w.bearer(w.createToken(w.alice.ID, "agent", false, nil)),
	}
	keys := func(r *response) []bool {
		r.t.Helper()
		var body struct {
			Credential  map[string]any   `json:"credential"`
			Credentials []map[string]any `json:"credentials"`
		}
		r.decode(&body)
		if body.Credential != nil {
			body.Credentials = append(body.Credentials, body.Credential)
		}
		if len(body.Credentials) == 0 {
			r.t.Fatalf("no credentials in %s", r.body)
		}
		var out []bool
		for _, c := range body.Credentials {
			key, ok := c["private_key"]
			if ok && key != "cHJpdmF0ZS1rZXk" {
				r.t.Fatalf("private_key = %v", key)
			}
			out = append(out, ok)
		}
		return out
	}
	i := 0
	for name, c := range callers {
		i++
		id := []string{"YWxpMQ", "YWxpMg", "YWxpMw"}[i-1]
		want := name == "basic"
		for _, r := range []*response{
			c.do("POST", "/api/v1/credentials", newCred(id, "a.com", id)).expect(http.StatusCreated),
			c.do("PATCH", "/api/v1/credentials/"+id, map[string]string{"label": "x"}).expect(http.StatusOK),
			c.do("GET", "/api/v1/credentials/"+id, nil).expect(http.StatusOK),
			c.do("GET", "/api/v1/credentials/Ym9i", nil).expect(http.StatusOK),
			c.do("GET", "/api/v1/credentials", nil).expect(http.StatusOK),
		} {
			for _, got := range keys(r) {
				if got != want {
					t.Errorf("%s: private_key present = %v, want %v in %s", name, got, want, r.body)
				}
			}
		}
		// Batch results never carry keys.
		r := c.do("POST", "/api/v1/credentials/share", map[string]any{"ids": []string{id}, "users": []string{"carol"}}).expect(http.StatusOK)
		if strings.Contains(string(r.body), "private_key") {
			t.Errorf("%s share results carry a private key: %s", name, r.body)
		}
	}

	// Administrators never see keys, whatever the authentication.
	rootSession := w.browser()
	rootSession.do("POST", "/api/v1/auth/login", map[string]string{"username": "root", "password": "pw"}).expect(http.StatusOK)
	for name, c := range map[string]*client{
		"basic":   w.as("root"),
		"session": rootSession,
		"token":   w.bearer(w.createToken(w.root.ID, "ops", false, nil)),
	} {
		for _, r := range []*response{
			c.do("GET", "/api/v1/admin/credentials", nil),
			c.do("GET", "/api/v1/admin/credentials/Ym9i", nil),
			c.do("PATCH", "/api/v1/admin/credentials/Ym9i", map[string]string{"label": name}),
			c.do("GET", fmt.Sprintf("/api/v1/admin/users/%d/credentials", w.alice.ID), nil),
			c.do("POST", "/api/v1/admin/credentials/transfer", map[string]any{"ids": []string{"Ym9i"}, "to": "carol", "dry_run": true}),
		} {
			r.expect(http.StatusOK)
			if strings.Contains(string(r.body), "private_key") || strings.Contains(string(r.body), "cHJpdmF0ZS1rZXk") {
				t.Errorf("%s admin response carries a private key: %s", name, r.body)
			}
		}
	}
}
