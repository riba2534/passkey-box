package api_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/riba2534/passkey-box/server/internal/store"
)

// world is an env with an administrator (root) and three users, all with
// password "pw".
type world struct {
	*env
	root, alice, bob, carol store.User
}

func newWorld(t *testing.T) *world {
	t.Helper()
	e := newEnv(t)
	return &world{env: e,
		root:  e.createUser("root", "pw", true),
		alice: e.createUser("alice", "pw", false),
		bob:   e.createUser("bob", "pw", false),
		carol: e.createUser("carol", "pw", false),
	}
}

func (w *world) as(name string) *client { return w.basic(name, "pw") }

// register stores a credential for owner through the API.
func (w *world) register(owner, id, rpID, handle string) {
	w.t.Helper()
	w.as(owner).do("POST", "/api/v1/credentials", newCred(id, rpID, handle)).expect(http.StatusCreated)
}

// shareWith shares the owner's credential with users through the API.
func (w *world) shareWith(owner, id string, users ...string) {
	w.t.Helper()
	w.as(owner).do("POST", "/api/v1/credentials/share", map[string]any{"ids": []string{id}, "users": users}).expect(http.StatusOK)
}

func (w *world) audit(action string) []store.AuditEvent {
	w.t.Helper()
	return w.events(store.AuditFilter{Action: action, Limit: 1000})
}

type briefJSON struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
}

func brief(u store.User) briefJSON { return briefJSON{ID: u.ID, Username: u.Username} }

type resultJSON struct {
	Credential struct {
		ID       string     `json:"id"`
		RPID     string     `json:"rp_id"`
		UserName string     `json:"user_name"`
		Owner    *briefJSON `json:"owner"`
	} `json:"credential"`
	User       *briefJSON `json:"user"`
	From       *briefJSON `json:"from"`
	To         *briefJSON `json:"to"`
	Status     string     `json:"status"`
	KeepAccess *bool      `json:"keep_access"`
	Warnings   []string   `json:"warnings"`
}

// results decodes a batch response and checks its dry_run flag and that every
// result has a warnings array.
func (r *response) results(dryRun bool) []resultJSON {
	r.t.Helper()
	var body struct {
		DryRun  *bool        `json:"dry_run"`
		Results []resultJSON `json:"results"`
	}
	r.expect(http.StatusOK).decode(&body)
	if body.DryRun == nil || *body.DryRun != dryRun || body.Results == nil {
		r.t.Fatalf("batch response = %s, want dry_run %v and results", r.body, dryRun)
	}
	for _, res := range body.Results {
		if res.Warnings == nil || res.Credential.Owner == nil {
			r.t.Fatalf("result without warnings or owner: %s", r.body)
		}
	}
	return body.Results
}

// summary renders results as "id:user:status" (share) or "id:from>to:status"
// (transfer) or "id:status".
func summary(results []resultJSON) []string {
	var out []string
	for _, r := range results {
		switch {
		case r.User != nil:
			out = append(out, r.Credential.ID+":"+r.User.Username+":"+r.Status)
		case r.From != nil:
			out = append(out, r.Credential.ID+":"+r.From.Username+">"+r.To.Username+":"+r.Status)
		default:
			out = append(out, r.Credential.ID+":"+r.Status)
		}
	}
	return out
}

func listIDs(c *client, path string) []string {
	return credIDs(c.do("GET", path, nil).expect(http.StatusOK).credentials())
}

func TestShareCredentials(t *testing.T) {
	w := newWorld(t)
	w.register("alice", "YQ", "github.com", "MQ")
	w.register("alice", "Yg", "gitlab.com", "Mg")
	w.register("bob", "Ym9i", "github.com", "Yg")
	if err := w.store.SetDisabled(t.Context(), w.carol.ID, true); err != nil {
		t.Fatal(err)
	}
	alice := w.as("alice")
	body := map[string]any{"ids": []string{"YQ", "Yg"}, "users": []any{"BOB", w.carol.ID}}

	// A dry run returns the real results and changes nothing.
	before := len(w.audit(""))
	body["dry_run"] = true
	dry := alice.do("POST", "/api/v1/credentials/share", body).results(true)
	if n := len(w.audit("")); n != before || len(listIDs(w.as("bob"), "/api/v1/credentials")) != 1 {
		t.Fatalf("dry run changed something: %d events", n-before)
	}
	body["dry_run"] = false
	res := alice.do("POST", "/api/v1/credentials/share", body).results(false)
	if !reflect.DeepEqual(dry, res) {
		t.Fatalf("dry run %+v\nreal    %+v", dry, res)
	}
	if got := summary(res); !slices.Equal(got, []string{"YQ:bob:shared", "YQ:carol:shared", "Yg:bob:shared", "Yg:carol:shared"}) {
		t.Fatalf("results = %v", got)
	}
	r := res[1]
	if r.Credential.RPID != "github.com" || r.Credential.UserName != "alice@example.com" || *r.Credential.Owner != brief(w.alice) ||
		*r.User != brief(w.carol) || !slices.Equal(r.Warnings, []string{"user is disabled"}) || len(res[0].Warnings) != 0 {
		t.Fatalf("result = %+v", r)
	}
	if strings.Contains(string(alice.do("POST", "/api/v1/credentials/share", body).body), "private_key") {
		t.Fatal("batch results must not carry private keys")
	}

	// Sharing again is unchanged and not recorded twice.
	if got := summary(alice.do("POST", "/api/v1/credentials/share", map[string]any{"ids": []string{"YQ"}, "users": []string{"bob"}}).results(false)); !slices.Equal(got, []string{"YQ:bob:unchanged"}) {
		t.Fatalf("again = %v", got)
	}
	ev := w.audit("credential.share")
	if len(ev) != 4 || ev[0].Actor.Username != "alice" || ev[0].Via != "basic" || ev[0].Subject.ID != w.alice.ID ||
		ev[0].Target.ID != w.carol.ID || ev[0].Credential.ID != "Yg" {
		t.Fatalf("share events = %+v", ev)
	}

	// Bob sees the share, relative to him.
	bobView := w.as("bob").do("GET", "/api/v1/credentials?rp_id=github.com", nil).expect(http.StatusOK)
	var list struct {
		Credentials []map[string]any `json:"credentials"`
	}
	bobView.decode(&list)
	if len(list.Credentials) != 2 {
		t.Fatalf("bob's github.com credentials = %s", bobView.body)
	}
	// Bob's own credential is newer (same time, later insert) and comes first.
	shared := list.Credentials[1]
	if shared["id"] != "YQ" || shared["access"] != "shared" || shared["shared_at"] != "2026-11-20T03:30:00Z" ||
		shared["private_key"] != "cHJpdmF0ZS1rZXk" || fmt.Sprint(shared["owner"]) != fmt.Sprintf("map[id:%d username:alice]", w.alice.ID) {
		t.Fatalf("shared credential = %v", shared)
	}
	if _, ok := shared["shared_with"]; ok {
		t.Fatalf("a recipient must not see shared_with: %v", shared)
	}
	if own := list.Credentials[0]; own["id"] != "Ym9i" || own["access"] != "owner" || own["shared_at"] != nil || fmt.Sprint(own["shared_with"]) != "[]" {
		t.Fatalf("own credential = %v", own)
	}
}

func TestShareItemErrors(t *testing.T) {
	w := newWorld(t)
	w.register("alice", "YQ", "a.com", "MQ")
	w.register("bob", "Ym9i", "b.com", "Mg")
	w.register("carol", "Y2Fy", "c.com", "Mw")
	w.shareWith("bob", "Ym9i", "alice")
	before := len(w.audit(""))

	got := w.as("alice").do("POST", "/api/v1/credentials/share", map[string]any{
		"ids":   []string{"YQ", "Ym9i", "Y2Fy", "nope", "YQ"},
		"users": []any{"carol", "alice", "ghost", 999, "CAROL", w.carol.ID},
	}).items()
	want := []string{
		"ids[1]=Ym9i:forbidden", "ids[2]=Y2Fy:not_found", "ids[3]=nope:not_found", "ids[4]=YQ:invalid_request",
		"users[2]=ghost:not_found", "users[3]=999:not_found", "users[4]=CAROL:invalid_request", fmt.Sprintf("users[5]=%d:invalid_request", w.carol.ID),
		"users[1]=alice:invalid_request",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("items = %v\nwant    %v", got, want)
	}
	// All or nothing: the valid pair (YQ, carol) was not shared either.
	if n := len(w.audit("")); n != before || len(listIDs(w.as("carol"), "/api/v1/credentials")) != 1 {
		t.Fatalf("a failed batch changed something (%d events)", n)
	}
}

func TestUnshareCredentials(t *testing.T) {
	w := newWorld(t)
	w.register("alice", "YQ", "a.com", "MQ")
	w.register("alice", "Yg", "b.com", "Mg")
	w.shareWith("alice", "YQ", "bob", "carol")
	alice := w.as("alice")

	res := alice.do("POST", "/api/v1/credentials/unshare", map[string]any{"ids": []string{"YQ", "Yg"}, "users": []string{"bob"}, "dry_run": true}).results(true)
	if got := summary(res); !slices.Equal(got, []string{"YQ:bob:unshared", "Yg:bob:unchanged"}) || len(listIDs(w.as("bob"), "/api/v1/credentials")) != 1 {
		t.Fatalf("dry run = %v", got)
	}
	alice.do("POST", "/api/v1/credentials/unshare", map[string]any{"ids": []string{"YQ"}, "users": []any{w.bob.ID}}).results(false)
	if n := len(listIDs(w.as("bob"), "/api/v1/credentials")); n != 0 {
		t.Fatalf("bob still sees %d credentials", n)
	}
	w.shareWith("alice", "Yg", "bob")
	res = alice.do("POST", "/api/v1/credentials/unshare", map[string]any{"ids": []string{"YQ", "Yg"}, "all": true}).results(false)
	if got := summary(res); !slices.Equal(got, []string{"YQ:carol:unshared", "Yg:bob:unshared"}) {
		t.Fatalf("unshare all = %v", got)
	}
	if got := alice.do("POST", "/api/v1/credentials/unshare", map[string]any{"ids": []string{"YQ"}, "all": true}).results(false); len(got) != 0 {
		t.Fatalf("nothing left to unshare = %v", got)
	}
	ev := w.audit("credential.unshare")
	if len(ev) != 3 || ev[0].Target.Username != "bob" || ev[0].Subject.Username != "alice" {
		t.Fatalf("unshare events = %+v", ev)
	}
}

func TestTransferCredentials(t *testing.T) {
	w := newWorld(t)
	w.register("alice", "cGxhaW4", "a.com", "MQ")
	w.register("alice", "a2VlcA", "b.com", "Mg")
	w.register("alice", "cmVjaXA", "c.com", "Mw")
	w.register("alice", "ZHVw", "D.COM", "NA")
	w.register("bob", "Ym9i", "d.com", "NA")
	w.shareWith("alice", "cGxhaW4", "carol")
	w.shareWith("alice", "cmVjaXA", "bob", "carol")
	alice := w.as("alice")
	transfer := func(ids []string, to any, keep, dry bool) []resultJSON {
		return alice.do("POST", "/api/v1/credentials/transfer", map[string]any{"ids": ids, "to": to, "keep_access": keep, "dry_run": dry}).results(dry)
	}

	before := len(w.audit(""))
	dry := transfer([]string{"cGxhaW4", "cmVjaXA", "ZHVw"}, "bob", false, true)
	if len(w.audit("")) != before || len(listIDs(alice, "/api/v1/credentials?access=owned")) != 4 {
		t.Fatal("a dry run transferred")
	}
	res := transfer([]string{"cGxhaW4", "cmVjaXA", "ZHVw"}, "bob", false, false)
	if !reflect.DeepEqual(dry, res) {
		t.Fatalf("dry run %+v\nreal    %+v", dry, res)
	}
	if got := summary(res); !slices.Equal(got, []string{"cGxhaW4:alice>bob:transferred", "cmVjaXA:alice>bob:transferred", "ZHVw:alice>bob:transferred"}) {
		t.Fatalf("results = %v", got)
	}
	if *res[0].KeepAccess || len(res[0].Warnings) != 0 || len(res[1].Warnings) != 0 ||
		!slices.Equal(res[2].Warnings, []string{"bob already has a passkey for this account"}) || *res[2].Credential.Owner != brief(w.alice) {
		t.Fatalf("results = %+v", res)
	}

	// Plain: alice loses access, carol keeps hers.
	alice.do("GET", "/api/v1/credentials/cGxhaW4", nil).expectError(http.StatusNotFound, "not_found")
	if got := w.as("carol").do("GET", "/api/v1/credentials/cGxhaW4", nil).expect(http.StatusOK).credential(); got.ID != "cGxhaW4" {
		t.Fatalf("carol's share = %+v", got)
	}
	// Bob's share of a credential he now owns is gone; carol's stays.
	var owned struct {
		Credential struct {
			Access     string `json:"access"`
			SharedWith []struct {
				User briefJSON `json:"user"`
			} `json:"shared_with"`
		} `json:"credential"`
	}
	w.as("bob").do("GET", "/api/v1/credentials/cmVjaXA", nil).expect(http.StatusOK).decode(&owned)
	if owned.Credential.Access != "owner" || len(owned.Credential.SharedWith) != 1 || owned.Credential.SharedWith[0].User != brief(w.carol) {
		t.Fatalf("recipient became owner = %+v", owned)
	}
	// Both credentials for the same account are kept.
	if got := listIDs(w.as("bob"), "/api/v1/credentials?rp_id=d.com"); len(got) != 2 {
		t.Fatalf("bob's d.com credentials = %v", got)
	}

	// keep_access: alice becomes a recipient, shared by herself.
	res = transfer([]string{"a2VlcA"}, w.carol.ID, true, false)
	if got := summary(res); !slices.Equal(got, []string{"a2VlcA:alice>carol:transferred"}) || !*res[0].KeepAccess {
		t.Fatalf("keep_access = %+v", res)
	}
	var kept struct {
		Credential struct {
			Access     string    `json:"access"`
			SharedAt   *string   `json:"shared_at"`
			Owner      briefJSON `json:"owner"`
			SharedWith *[]any    `json:"shared_with"`
			PrivateKey *string   `json:"private_key"`
		} `json:"credential"`
	}
	alice.do("GET", "/api/v1/credentials/a2VlcA", nil).expect(http.StatusOK).decode(&kept)
	if kc := kept.Credential; kc.Access != "shared" || kc.SharedAt == nil || *kc.SharedAt != "2026-11-20T03:30:00Z" ||
		kc.Owner != brief(w.carol) || kc.SharedWith != nil || kc.PrivateKey == nil {
		t.Fatalf("kept access = %+v", kept)
	}
	var carolView struct {
		Credential struct {
			SharedWith []struct {
				User     briefJSON  `json:"user"`
				SharedBy *briefJSON `json:"shared_by"`
			} `json:"shared_with"`
		} `json:"credential"`
	}
	w.as("carol").do("GET", "/api/v1/credentials/a2VlcA", nil).expect(http.StatusOK).decode(&carolView)
	if sw := carolView.Credential.SharedWith; len(sw) != 1 || sw[0].User != brief(w.alice) || sw[0].SharedBy == nil || *sw[0].SharedBy != brief(w.alice) {
		t.Fatalf("carol's view of the kept share = %+v", carolView)
	}
	alice.do("PATCH", "/api/v1/credentials/a2VlcA", map[string]string{"label": "x"}).expectError(http.StatusForbidden, "forbidden")

	// Transferring to the owner is unchanged; recipients may not transfer.
	if got := summary(w.as("carol").do("POST", "/api/v1/credentials/transfer", map[string]any{"ids": []string{"a2VlcA"}, "to": "Carol"}).results(false)); !slices.Equal(got, []string{"a2VlcA:carol>carol:unchanged"}) {
		t.Fatalf("to the owner = %v", got)
	}
	if got := alice.do("POST", "/api/v1/credentials/transfer", map[string]any{"ids": []string{"a2VlcA"}, "to": "alice"}).items(); !slices.Equal(got, []string{"ids[0]=a2VlcA:forbidden"}) {
		t.Fatalf("recipient transfer = %v", got)
	}
	if got := alice.do("POST", "/api/v1/credentials/transfer", map[string]any{"ids": []string{"ZHVw"}, "to": "ghost"}).items(); !slices.Equal(got, []string{"ids[0]=ZHVw:not_found", "to[0]=ghost:not_found"}) {
		t.Fatalf("bad transfer = %v", got)
	}

	ev := w.audit("credential.transfer")
	if len(ev) != 4 || ev[0].Subject.Username != "alice" || ev[0].Target.Username != "carol" || string(ev[0].Detail) != `{"keep_access":true}` ||
		string(ev[1].Detail) != `{"keep_access":false}` {
		t.Fatalf("transfer events = %+v", ev)
	}
}

func TestLeaveAndBatchDelete(t *testing.T) {
	w := newWorld(t)
	w.register("alice", "YQ", "a.com", "MQ")
	w.register("bob", "Yg", "b.com", "Mg")
	w.register("bob", "Yw", "c.com", "Mw")
	w.shareWith("bob", "Yg", "alice", "carol")
	w.shareWith("bob", "Yw", "alice")
	alice := w.as("alice")

	if got := alice.do("POST", "/api/v1/credentials/leave", map[string]any{"ids": []string{"Yg", "YQ", "bogus"}}).items(); !slices.Equal(got, []string{"ids[1]=YQ:not_found", "ids[2]=bogus:not_found"}) {
		t.Fatalf("leave errors = %v", got)
	}
	res := alice.do("POST", "/api/v1/credentials/leave", map[string]any{"ids": []string{"Yg"}, "dry_run": true}).results(true)
	if got := summary(res); !slices.Equal(got, []string{"Yg:left"}) || len(listIDs(alice, "/api/v1/credentials")) != 3 {
		t.Fatalf("dry leave = %v", got)
	}
	alice.do("POST", "/api/v1/credentials/leave", map[string]any{"ids": []string{"Yg"}}).results(false)
	if got := listIDs(alice, "/api/v1/credentials"); !slices.Equal(got, []string{"Yw", "YQ"}) {
		t.Fatalf("after leave = %v", got)
	}
	if got := listIDs(w.as("carol"), "/api/v1/credentials"); !slices.Equal(got, []string{"Yg"}) {
		t.Fatalf("carol after alice left = %v", got)
	}

	if got := alice.do("POST", "/api/v1/credentials/batch-delete", map[string]any{"ids": []string{"YQ", "Yg"}}).items(); !slices.Equal(got, []string{"ids[1]=Yg:not_found"}) {
		t.Fatalf("delete errors = %v", got)
	}
	res = alice.do("POST", "/api/v1/credentials/batch-delete", map[string]any{"ids": []string{"YQ", "Yw"}}).results(false)
	if got := summary(res); !slices.Equal(got, []string{"YQ:deleted", "Yw:left"}) {
		t.Fatalf("batch-delete = %v", got)
	}
	if got := listIDs(alice, "/api/v1/credentials"); len(got) != 0 {
		t.Fatalf("alice after batch-delete = %v", got)
	}
	if got := listIDs(w.as("bob"), "/api/v1/credentials"); !slices.Equal(got, []string{"Yw", "Yg"}) {
		t.Fatalf("bob lost credentials: %v", got)
	}
	var actions []string
	for _, e := range w.audit("credential.")[:3] {
		actions = append(actions, e.Action+":"+e.Credential.ID+":"+e.Subject.Username)
	}
	if !slices.Equal(actions, []string{"credential.leave:Yw:bob", "credential.delete:YQ:alice", "credential.leave:Yg:bob"}) {
		t.Fatalf("events = %v", actions)
	}
}

func TestBatchRequestValidation(t *testing.T) {
	w := newWorld(t)
	w.register("alice", "YQ", "a.com", "MQ")
	alice := w.as("alice")
	many := func(n int, f func(int) any) []any {
		out := make([]any, n)
		for i := range out {
			out[i] = f(i)
		}
		return out
	}
	ids := func(n int) []any { return many(n, func(i int) any { return fmt.Sprintf("id%d", i) }) }
	users := func(n int) []any { return many(n, func(i int) any { return fmt.Sprintf("u%d", i) }) }
	ok := []any{"YQ"}
	for _, prefix := range []string{"/api/v1/credentials/", "/api/v1/admin/credentials/"} {
		client := alice
		if strings.Contains(prefix, "admin") {
			client = w.as("root")
		}
		cases := map[string]struct {
			path string
			body any
		}{
			"bad json":          {"share", "{"},
			"trailing data":     {"share", `{"ids": ["YQ"], "users": ["bob"]} {}`},
			"ids missing":       {"share", map[string]any{"users": []string{"bob"}}},
			"ids empty":         {"share", map[string]any{"ids": []any{}, "users": []string{"bob"}}},
			"ids not an array":  {"share", map[string]any{"ids": "YQ", "users": []string{"bob"}}},
			"ids not strings":   {"share", map[string]any{"ids": []any{1}, "users": []string{"bob"}}},
			"too many ids":      {"transfer", map[string]any{"ids": ids(1001), "to": "bob"}},
			"users missing":     {"share", map[string]any{"ids": ok}},
			"users empty":       {"share", map[string]any{"ids": ok, "users": []any{}}},
			"user is a bool":    {"share", map[string]any{"ids": ok, "users": []any{true}}},
			"user is null":      {"share", map[string]any{"ids": ok, "users": []any{nil}}},
			"user is negative":  {"share", map[string]any{"ids": ok, "users": []any{-1}}},
			"user is a float":   {"share", map[string]any{"ids": ok, "users": []any{1.5}}},
			"too many users":    {"share", map[string]any{"ids": ok, "users": users(101)}},
			"too many pairs":    {"share", map[string]any{"ids": ids(101), "users": users(100)}},
			"unshare neither":   {"unshare", map[string]any{"ids": ok}},
			"unshare all false": {"unshare", map[string]any{"ids": ok, "all": false}},
			"unshare both":      {"unshare", map[string]any{"ids": ok, "users": []string{"bob"}, "all": true}},
			"unshare empty":     {"unshare", map[string]any{"ids": ok, "users": []any{}}},
			"unshare pairs":     {"unshare", map[string]any{"ids": ids(101), "users": users(100)}},
			"to missing":        {"transfer", map[string]any{"ids": ok}},
			"to null":           {"transfer", map[string]any{"ids": ok, "to": nil}},
			"to is an object":   {"transfer", map[string]any{"ids": ok, "to": map[string]any{"id": 1}}},
			"delete ids empty":  {"batch-delete", map[string]any{"ids": []any{}}},
		}
		if prefix == "/api/v1/credentials/" {
			cases["leave ids missing"] = struct {
				path string
				body any
			}{"leave", map[string]any{}}
		}
		for name, tc := range cases {
			t.Run(prefix+name, func(t *testing.T) {
				client.do("POST", prefix+tc.path, tc.body).expectPlainError()
			})
		}
	}
	// The limits themselves are allowed.
	alice.do("POST", "/api/v1/credentials/share", map[string]any{"ids": ids(100), "users": users(100)}).items()
	if n := len(w.audit("credential.share")); n != 0 {
		t.Fatalf("%d share events", n)
	}
}

// Every user endpoint keeps to the caller's credentials, recipients cannot do
// what only owners can, and administrators are the only way around that.
func TestCredentialAuthorization(t *testing.T) {
	w := newWorld(t)
	w.register("alice", "YWxpY2U", "a.com", "MQ")
	w.register("bob", "Ym9i", "b.com", "Mg")
	w.register("bob", "c2hhcmVk", "c.com", "Mw")
	w.shareWith("bob", "c2hhcmVk", "alice")
	alice := w.as("alice")
	before := len(w.audit("credential."))

	// Bob's unshared credential does not exist for alice.
	alice.do("GET", "/api/v1/credentials/Ym9i", nil).expectError(http.StatusNotFound, "not_found")
	alice.do("PATCH", "/api/v1/credentials/Ym9i", map[string]string{"label": "x"}).expectError(http.StatusNotFound, "not_found")
	alice.do("POST", "/api/v1/credentials/Ym9i/use", nil).expectError(http.StatusNotFound, "not_found")
	alice.do("DELETE", "/api/v1/credentials/Ym9i", nil).expectError(http.StatusNotFound, "not_found")
	for path, body := range map[string]map[string]any{
		"share":        {"users": []string{"carol"}},
		"unshare":      {"all": true},
		"transfer":     {"to": "alice"},
		"leave":        {},
		"batch-delete": {},
	} {
		body["ids"] = []string{"Ym9i"}
		if got := alice.do("POST", "/api/v1/credentials/"+path, body).items(); !slices.Equal(got, []string{"ids[0]=Ym9i:not_found"}) {
			t.Errorf("%s of a stranger's credential = %v", path, got)
		}
		// A shared credential is visible, but only the owner may share,
		// unshare or transfer it.
		body["ids"] = []string{"c2hhcmVk"}
		body["dry_run"] = true
		r := alice.do("POST", "/api/v1/credentials/"+path, body)
		switch path {
		case "leave", "batch-delete":
			if got := summary(r.results(true)); !slices.Equal(got, []string{"c2hhcmVk:left"}) {
				t.Errorf("%s of a shared credential = %v", path, got)
			}
		default:
			if got := r.items(); !slices.Equal(got, []string{"ids[0]=c2hhcmVk:forbidden"}) {
				t.Errorf("%s of a shared credential = %v", path, got)
			}
		}
	}
	alice.do("PATCH", "/api/v1/credentials/c2hhcmVk", map[string]string{"label": "x"}).expectError(http.StatusForbidden, "forbidden")
	if n := len(w.audit("credential.")); n != before {
		t.Fatalf("refused requests wrote %d events", n-before)
	}

	// Normal users get 403 from every admin credential endpoint.
	adminEndpoints := []struct {
		method, path string
		body         any
	}{
		{"GET", "/api/v1/admin/credentials", nil},
		{"GET", "/api/v1/admin/credentials/Ym9i", nil},
		{"PATCH", "/api/v1/admin/credentials/Ym9i", map[string]string{"label": "x"}},
		{"DELETE", "/api/v1/admin/credentials/Ym9i", nil},
		{"POST", "/api/v1/admin/credentials/share", map[string]any{"ids": []string{"Ym9i"}, "users": []string{"alice"}}},
		{"POST", "/api/v1/admin/credentials/unshare", map[string]any{"ids": []string{"c2hhcmVk"}, "all": true}},
		{"POST", "/api/v1/admin/credentials/transfer", map[string]any{"ids": []string{"Ym9i"}, "to": "alice"}},
		{"POST", "/api/v1/admin/credentials/batch-delete", map[string]any{"ids": []string{"Ym9i"}}},
		{"GET", fmt.Sprintf("/api/v1/admin/users/%d/credentials", w.bob.ID), nil},
		{"DELETE", fmt.Sprintf("/api/v1/admin/users/%d/credentials/Ym9i", w.bob.ID), nil},
	}
	token := w.bearer(w.createToken(w.alice.ID, "agent", false, nil))
	for _, ep := range adminEndpoints {
		alice.do(ep.method, ep.path, ep.body).expectError(http.StatusForbidden, "forbidden")
		token.do(ep.method, ep.path, ep.body).expectError(http.StatusForbidden, "forbidden")
		w.anon().do(ep.method, ep.path, ep.body).expectError(http.StatusUnauthorized, "unauthorized")
	}

	// Read-only tokens, even an administrator's, cannot write.
	for _, owner := range []store.User{w.alice, w.root} {
		ro := w.bearer(w.createToken(owner.ID, "reader", true, nil))
		writes := []struct {
			method, path string
			body         any
		}{
			{"POST", "/api/v1/credentials/share", map[string]any{"ids": []string{"YWxpY2U"}, "users": []string{"carol"}}},
			{"POST", "/api/v1/credentials/unshare", map[string]any{"ids": []string{"YWxpY2U"}, "all": true}},
			{"POST", "/api/v1/credentials/transfer", map[string]any{"ids": []string{"YWxpY2U"}, "to": "carol"}},
			{"POST", "/api/v1/credentials/leave", map[string]any{"ids": []string{"c2hhcmVk"}}},
			{"POST", "/api/v1/credentials/batch-delete", map[string]any{"ids": []string{"YWxpY2U"}}},
			{"PATCH", "/api/v1/credentials/YWxpY2U", map[string]string{"label": "x"}},
			{"DELETE", "/api/v1/credentials/YWxpY2U", nil},
		}
		if owner.IsAdmin {
			writes = adminEndpoints[2:8]
		}
		for _, ep := range writes {
			ro.do(ep.method, ep.path, ep.body).expectError(http.StatusForbidden, "read_only_token")
		}
	}
	if n := len(w.audit("credential.")); n != before {
		t.Fatalf("refused requests wrote %d events", n-before)
	}
	if got := listIDs(w.as("bob"), "/api/v1/credentials"); !slices.Equal(got, []string{"c2hhcmVk", "Ym9i"}) {
		t.Fatalf("bob's credentials = %v", got)
	}
}

// A dry run or a failed batch must leave no trace in the audit log, even for
// operations that would write several events.
func TestBatchRollbackLeavesNoEvents(t *testing.T) {
	w := newWorld(t)
	w.register("alice", "YQ", "a.com", "MQ")
	w.register("alice", "Yg", "b.com", "Mg")
	w.shareWith("alice", "YQ", "bob")
	before, _ := json.Marshal(w.audit(""))
	root := w.as("root")
	for _, req := range []struct {
		path string
		body map[string]any
	}{
		{"share", map[string]any{"ids": []string{"YQ", "Yg"}, "users": []string{"carol"}}},
		{"unshare", map[string]any{"ids": []string{"YQ", "Yg"}, "all": true}},
		{"transfer", map[string]any{"ids": []string{"YQ", "Yg"}, "to": "carol", "keep_access": true}},
		{"batch-delete", map[string]any{"ids": []string{"YQ", "Yg"}}},
	} {
		req.body["dry_run"] = true
		root.do("POST", "/api/v1/admin/credentials/"+req.path, req.body).results(true)
		req.body["dry_run"] = false
		req.body["ids"] = []string{"YQ", "Yg", "bogus"}
		if got := root.do("POST", "/api/v1/admin/credentials/"+req.path, req.body).items(); !slices.Equal(got, []string{"ids[2]=bogus:not_found"}) {
			t.Fatalf("%s items = %v", req.path, got)
		}
	}
	if after, _ := json.Marshal(w.audit("")); string(after) != string(before) {
		t.Fatalf("events changed:\n%s\n%s", before, after)
	}
	if got := listIDs(w.as("bob"), "/api/v1/credentials"); !slices.Equal(got, []string{"YQ"}) {
		t.Fatalf("bob's credentials = %v", got)
	}
	if got := listIDs(w.as("alice"), "/api/v1/credentials?access=owned"); !slices.Equal(got, []string{"Yg", "YQ"}) {
		t.Fatalf("alice's credentials = %v", got)
	}
}
