package api_test

import (
	"fmt"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

type eventJSON struct {
	ID         int64           `json:"id"`
	At         string          `json:"at"`
	Actor      *map[string]any `json:"actor"`
	Via        string          `json:"via"`
	Action     string          `json:"action"`
	Subject    *map[string]any `json:"subject"`
	Target     *map[string]any `json:"target"`
	Credential *map[string]any `json:"credential"`
	Detail     map[string]any  `json:"detail"`
}

type eventPage struct {
	Events     []eventJSON `json:"events"`
	NextBefore *int64      `json:"next_before"`
}

func (r *response) eventPage() eventPage {
	r.t.Helper()
	var p eventPage
	r.decode(&p)
	if p.Events == nil {
		r.t.Fatalf("events missing or null in %s", r.body)
	}
	return p
}

func actions(events []eventJSON) []string {
	out := []string{}
	for _, e := range events {
		out = append(out, e.Action)
	}
	return out
}

func brief(id int64, name string) *map[string]any {
	return &map[string]any{"id": float64(id), "username": name}
}

func TestMyActivity(t *testing.T) {
	e := newEnv(t)
	e.createUser("root", "pw", true)
	alice := e.createUser("alice", "pw", false)
	bob := e.createUser("bob", "pw", false)
	admin := e.basic("root", "pw")
	e.advance(time.Minute)
	admin.do("PATCH", fmt.Sprintf("/api/v1/admin/users/%d", alice.ID), map[string]any{"note": "a"}).expect(http.StatusOK)
	admin.do("PATCH", fmt.Sprintf("/api/v1/admin/users/%d", bob.ID), map[string]any{"note": "b"}).expect(http.StatusOK)
	e.basic("alice", "pw").do("PUT", "/api/v1/me/password", map[string]string{"old_password": "pw", "new_password": "pw2"}).expect(http.StatusNoContent)
	c := e.basic("alice", "pw2")

	r := c.do("GET", "/api/v1/me/activity", nil).expect(http.StatusOK)
	p := r.eventPage()
	if got := actions(p.Events); !slices.Equal(got, []string{"user.update", "user.update", "user.create"}) || p.NextBefore != nil {
		t.Fatalf("activity = %v, next %v", got, p.NextBefore)
	}
	pw := p.Events[0]
	if !reflect.DeepEqual(pw.Actor, brief(alice.ID, "alice")) || pw.Via != "basic" || !reflect.DeepEqual(pw.Subject, brief(alice.ID, "alice")) ||
		pw.Target != nil || pw.Credential != nil || !reflect.DeepEqual(pw.Detail, map[string]any{"changes": map[string]any{"password": true}}) ||
		pw.At != "2026-11-20T03:31:00Z" {
		t.Fatalf("password event = %+v", pw)
	}
	if created := p.Events[2]; created.Actor != nil || created.Via != "system" || !reflect.DeepEqual(created.Detail, map[string]any{"is_admin": false}) {
		t.Fatalf("create event = %+v", created)
	}
	// Absent parties are null, not missing.
	for _, field := range []string{`"actor":null`, `"target":null`, `"credential":null`} {
		if !strings.Contains(string(r.body), field) {
			t.Errorf("activity lacks %s: %s", field, r.body)
		}
	}

	first := c.do("GET", "/api/v1/me/activity?limit=2", nil).expect(http.StatusOK).eventPage()
	if len(first.Events) != 2 || first.NextBefore == nil || *first.NextBefore != first.Events[1].ID {
		t.Fatalf("first page = %+v", first)
	}
	second := c.do("GET", fmt.Sprintf("/api/v1/me/activity?limit=2&before=%d", *first.NextBefore), nil).expect(http.StatusOK).eventPage()
	if got := actions(second.Events); !slices.Equal(got, []string{"user.create"}) || second.NextBefore != nil {
		t.Fatalf("second page = %+v", second)
	}
	c.do("GET", "/api/v1/me/activity?limit=200", nil).expect(http.StatusOK)
	for _, q := range []string{"limit=0", "limit=201", "limit=x", "before=x", "before=0", "before=-1"} {
		c.do("GET", "/api/v1/me/activity?"+q, nil).expectError(http.StatusBadRequest, "invalid_request")
	}
}

func TestAdminAudit(t *testing.T) {
	e := newEnv(t)
	root := e.createUser("root", "pw", true)
	alice := e.createUser("alice", "pw", false)
	e.createUser("bob", "pw", false)
	admin := e.basic("root", "pw")
	e.basic("alice", "pw").do("POST", "/api/v1/credentials", newCred("YWxpY2U", "github.com", "MQ")).expect(http.StatusCreated)
	admin.do("PATCH", fmt.Sprintf("/api/v1/admin/users/%d", alice.ID), map[string]any{"note": "a"}).expect(http.StatusOK)
	admin.do("POST", "/api/v1/admin/users/batch-delete", map[string]any{"users": []any{"alice"}, "transfer_credentials_to": "bob"}).expect(http.StatusOK)

	for query, want := range map[string][]string{
		"":                                   {"user.delete", "credential.transfer", "user.update", "user.create", "user.create", "user.create"},
		fmt.Sprintf("?user_id=%d", alice.ID): {"user.delete", "credential.transfer", "user.update", "user.create"},
		fmt.Sprintf("?actor_id=%d", root.ID): {"user.delete", "credential.transfer", "user.update"},
		"?action=user.":                      {"user.delete", "user.update", "user.create", "user.create", "user.create"},
		"?action=user.update":                {"user.update"},
		"?action=user":                       {},
		"?credential_id=YWxpY2U":             {"credential.transfer"},
		"?limit=1":                           {"user.delete"},
	} {
		got := actions(admin.do("GET", "/api/v1/admin/audit"+query, nil).expect(http.StatusOK).eventPage().Events)
		if !slices.Equal(got, want) {
			t.Errorf("%q: got %v, want %v", query, got, want)
		}
	}
	tr := admin.do("GET", "/api/v1/admin/audit?action=credential.transfer", nil).expect(http.StatusOK).eventPage().Events[0]
	if !reflect.DeepEqual(tr.Credential, &map[string]any{"id": "YWxpY2U", "rp_id": "github.com", "user_name": "alice@example.com"}) ||
		!reflect.DeepEqual(tr.Subject, brief(alice.ID, "alice")) || (*tr.Target)["username"] != "bob" ||
		!reflect.DeepEqual(tr.Detail, map[string]any{"keep_access": false}) {
		t.Fatalf("transfer event = %+v", tr)
	}
	for _, q := range []string{"user_id=abc", "user_id=0", "actor_id=1.5", "before=x", "limit=201", "limit=0"} {
		admin.do("GET", "/api/v1/admin/audit?"+q, nil).expectError(http.StatusBadRequest, "invalid_request")
	}
}

func TestUserDirectory(t *testing.T) {
	e := newEnv(t)
	e.createUser("root", "pw", true)
	e.createUser("bob", "pw", false)
	alice := e.createUser("Alice", "pw", false)
	carol := e.createUser("carol", "pw", false)
	e.basic("root", "pw").do("PATCH", fmt.Sprintf("/api/v1/admin/users/%d", carol.ID), map[string]any{"disabled": true}).expect(http.StatusOK)

	r := e.bearer(e.createToken(alice.ID, "agent", true, nil)).do("GET", "/api/v1/users", nil).expect(http.StatusOK)
	var body struct {
		Users []map[string]any `json:"users"`
	}
	r.decode(&body)
	want := []map[string]any{
		{"id": float64(alice.ID), "username": "Alice"},
		{"id": float64(2), "username": "bob"},
		{"id": float64(1), "username": "root"},
	}
	if !reflect.DeepEqual(body.Users, want) {
		t.Fatalf("directory = %s", r.body)
	}
	e.anon().do("GET", "/api/v1/users", nil).expectError(http.StatusUnauthorized, "unauthorized")
}

func TestAdminOverview(t *testing.T) {
	e := newEnv(t)
	e.createUser("root", "pw", true)
	e.createUser("alice", "pw", false)
	bob := e.createUser("bob", "pw", false)
	a := e.basic("alice", "pw")
	a.do("POST", "/api/v1/credentials", newCred("YTE", "github.com", "MQ")).expect(http.StatusCreated)
	a.do("POST", "/api/v1/credentials", newCred("YTI", "GitHub.com", "Mg")).expect(http.StatusCreated)
	a.do("POST", "/api/v1/credentials", newCred("YTM", "gitlab.com", "Mw")).expect(http.StatusCreated)
	e.basic("bob", "pw").do("POST", "/api/v1/credentials", newCred("YjE", "github.com", "NA")).expect(http.StatusCreated)
	admin := e.basic("root", "pw")
	for i := range 12 {
		admin.do("PATCH", fmt.Sprintf("/api/v1/admin/users/%d", bob.ID), map[string]any{"note": fmt.Sprint(i)}).expect(http.StatusOK)
	}
	admin.do("PATCH", fmt.Sprintf("/api/v1/admin/users/%d", bob.ID), map[string]any{"disabled": true}).expect(http.StatusOK)

	var o struct {
		Users        map[string]int   `json:"users"`
		Credentials  map[string]int   `json:"credentials"`
		Sites        []map[string]any `json:"sites"`
		RecentEvents []eventJSON      `json:"recent_events"`
	}
	admin.do("GET", "/api/v1/admin/overview", nil).expect(http.StatusOK).decode(&o)
	if !reflect.DeepEqual(o.Users, map[string]int{"total": 3, "admins": 1, "disabled": 1}) {
		t.Errorf("users = %v", o.Users)
	}
	if !reflect.DeepEqual(o.Credentials, map[string]int{"total": 4, "shared": 0, "shares": 0, "sites": 2}) {
		t.Errorf("credentials = %v", o.Credentials)
	}
	wantSites := []map[string]any{
		{"rp_id": "github.com", "credentials": float64(3), "owners": float64(2)},
		{"rp_id": "gitlab.com", "credentials": float64(1), "owners": float64(1)},
	}
	if !reflect.DeepEqual(o.Sites, wantSites) {
		t.Errorf("sites = %v", o.Sites)
	}
	if len(o.RecentEvents) != 10 || o.RecentEvents[0].Action != "user.update" ||
		!reflect.DeepEqual(o.RecentEvents[0].Detail, map[string]any{"changes": map[string]any{"disabled": map[string]any{"from": false, "to": true}}}) {
		t.Fatalf("recent events = %+v", o.RecentEvents)
	}
}
