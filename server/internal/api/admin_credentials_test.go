package api_test

import (
	"fmt"
	"net/http"
	"slices"
	"testing"
	"time"
)

func TestAdminListCredentials(t *testing.T) {
	w := newWorld(t)
	w.register("alice", "YQ", "GitHub.com", "MQ")
	w.advance(time.Minute)
	w.register("alice", "Yg", "gitlab.com", "Mg")
	w.advance(time.Minute)
	w.register("bob", "Yw", "example.org", "Mw")
	w.advance(time.Minute)
	w.register("carol", "ZA", "github.com", "NA")
	w.shareWith("alice", "YQ", "bob")
	w.shareWith("carol", "ZA", "bob", "alice")
	root := w.as("root")
	root.do("PATCH", "/api/v1/admin/credentials/Yw", map[string]string{"label": "Shared Mailbox"}).expect(http.StatusOK)

	type page struct {
		Credentials []map[string]any `json:"credentials"`
		Total       *int             `json:"total"`
		Limit       *int             `json:"limit"`
		Offset      *int             `json:"offset"`
	}
	list := func(query string) ([]string, page) {
		t.Helper()
		var p page
		root.do("GET", "/api/v1/admin/credentials"+query, nil).expect(http.StatusOK).decode(&p)
		if p.Credentials == nil || p.Total == nil || p.Limit == nil || p.Offset == nil {
			t.Fatalf("%s: page = %+v", query, p)
		}
		ids := []string{}
		for _, c := range p.Credentials {
			ids = append(ids, c["id"].(string))
		}
		return ids, p
	}
	for query, want := range map[string][]string{
		"":                                    {"ZA", "Yw", "Yg", "YQ"},
		"?owner=ALICE":                        {"Yg", "YQ"},
		fmt.Sprintf("?owner_id=%d", w.bob.ID): {"Yw"},
		"?owner=nobody":                       {},
		"?owner_id=999":                       {},
		"?shared_with=Bob":                    {"ZA", "YQ"},
		fmt.Sprintf("?shared_with_id=%d", w.alice.ID): {"ZA"},
		"?shared_with=nobody":                         {},
		"?rp_id=GITHUB.COM":                           {"ZA", "YQ"},
		"?q=lab":                                      {"Yg"},
		"?q=MAILBOX":                                  {"Yw"},
		"?q=caro":                                     {"ZA"},
		"?q=%20example.org%20":                        {"Yw"},
		"?shared=true":                                {"ZA", "YQ"},
		"?shared=false":                               {"Yw", "Yg"},
		"?owner=alice&shared=false":                   {"Yg"},
	} {
		if got, p := list(query); !slices.Equal(got, want) || *p.Total != len(want) || *p.Limit != 100 || *p.Offset != 0 {
			t.Errorf("%s: got %v (total %d, limit %d), want %v", query, got, *p.Total, *p.Limit, want)
		}
	}
	got, p := list("?limit=2&offset=1")
	if !slices.Equal(got, []string{"Yw", "Yg"}) || *p.Total != 4 || *p.Limit != 2 || *p.Offset != 1 {
		t.Fatalf("page = %v %+v", got, p)
	}
	if got, p := list("?limit=500&offset=9"); len(got) != 0 || *p.Total != 4 || *p.Limit != 500 {
		t.Fatalf("past the end = %v %+v", got, p)
	}

	// The admin view: owner and shares, no access, no private key.
	_, p = list("?rp_id=github.com")
	za := p.Credentials[0]
	for _, key := range []string{"access", "shared_at", "private_key"} {
		if _, ok := za[key]; ok {
			t.Errorf("admin view has %s: %v", key, za)
		}
	}
	if fmt.Sprint(za["owner"]) != fmt.Sprintf("map[id:%d username:carol]", w.carol.ID) || len(za["shared_with"].([]any)) != 2 {
		t.Fatalf("admin view = %v", za)
	}
	if _, p = list("?owner=bob"); fmt.Sprint(p.Credentials[0]["shared_with"]) != "[]" {
		t.Fatalf("unshared admin view = %v", p.Credentials[0])
	}

	for _, query := range []string{
		"limit=0", "limit=501", "limit=-1", "limit=abc", "offset=-1", "offset=1.5",
		"owner_id=abc", "owner_id=0", "shared_with_id=x", "shared=yes", "shared=TRUE",
	} {
		root.do("GET", "/api/v1/admin/credentials?"+query, nil).expectError(http.StatusBadRequest, "invalid_request")
	}
}

func TestAdminCredentialEndpoints(t *testing.T) {
	w := newWorld(t)
	w.register("alice", "YQ", "a.com", "MQ")
	w.shareWith("alice", "YQ", "bob")
	root := w.as("root")

	var got struct {
		Credential map[string]any `json:"credential"`
	}
	root.do("GET", "/api/v1/admin/credentials/YQ", nil).expect(http.StatusOK).decode(&got)
	if got.Credential["id"] != "YQ" || len(got.Credential["shared_with"].([]any)) != 1 || got.Credential["access"] != nil {
		t.Fatalf("admin get = %v", got.Credential)
	}
	got.Credential = nil
	root.do("PATCH", "/api/v1/admin/credentials/YQ", map[string]string{"label": "by admin"}).expect(http.StatusOK).decode(&got)
	if got.Credential["label"] != "by admin" || got.Credential["shared_with"] == nil || got.Credential["private_key"] != nil {
		t.Fatalf("admin patch = %v", got.Credential)
	}
	if c := w.as("alice").do("GET", "/api/v1/credentials/YQ", nil).credential(); c.Label != "by admin" {
		t.Fatalf("alice's label = %q", c.Label)
	}
	root.do("PATCH", "/api/v1/admin/credentials/YQ", map[string]string{}).expectError(http.StatusBadRequest, "invalid_request")
	for _, method := range []string{"GET", "PATCH", "DELETE"} {
		root.do(method, "/api/v1/admin/credentials/bm9uZQ", map[string]string{"label": "x"}).expectError(http.StatusNotFound, "not_found")
	}
	root.do("DELETE", "/api/v1/admin/credentials/YQ", nil).expect(http.StatusNoContent)
	root.do("DELETE", "/api/v1/admin/credentials/YQ", nil).expectError(http.StatusNotFound, "not_found")
	if n := len(listIDs(w.as("bob"), "/api/v1/credentials")); n != 0 {
		t.Fatalf("bob sees %d credentials after the admin delete", n)
	}
	var events []string
	for _, e := range w.audit("credential.")[:2] {
		events = append(events, fmt.Sprintf("%s %s %s %s", e.Action, e.Actor.Username, e.Subject.Username, e.Detail))
	}
	if !slices.Equal(events, []string{"credential.delete root alice {}", `credential.update root alice {"label":{"from":"","to":"by admin"}}`}) {
		t.Fatalf("events = %v", events)
	}
}

func TestAdminCredentialBatches(t *testing.T) {
	w := newWorld(t)
	w.register("alice", "YQ", "a.com", "MQ")
	w.register("bob", "Yg", "b.com", "Mg")
	w.register("carol", "Yw", "c.com", "Mw")
	w.shareWith("carol", "Yw", "alice")
	root := w.as("root")

	res := root.do("POST", "/api/v1/admin/credentials/share", map[string]any{"ids": []string{"YQ", "Yg"}, "users": []string{"carol"}}).results(false)
	if got := summary(res); !slices.Equal(got, []string{"YQ:carol:shared", "Yg:carol:shared"}) || *res[1].Credential.Owner != brief(w.bob) {
		t.Fatalf("admin share = %+v", res)
	}
	var shared struct {
		Credential accessJSON `json:"credential"`
	}
	w.as("bob").do("GET", "/api/v1/credentials/Yg", nil).expect(http.StatusOK).decode(&shared)
	if sw := *shared.Credential.SharedWith; len(sw) != 1 || *sw[0].SharedBy != brief(w.root) {
		t.Fatalf("shared_by = %+v", sw)
	}
	if ev := w.audit("credential.share"); ev[0].Actor.Username != "root" || ev[0].Subject.Username != "bob" || ev[0].Target.Username != "carol" {
		t.Fatalf("share event = %+v", ev[0])
	}

	// The owner is still not a share target.
	if got := root.do("POST", "/api/v1/admin/credentials/share", map[string]any{"ids": []string{"YQ"}, "users": []string{"alice"}}).items(); !slices.Equal(got, []string{"users[0]=alice:invalid_request"}) {
		t.Fatalf("share with the owner = %v", got)
	}

	res = root.do("POST", "/api/v1/admin/credentials/unshare", map[string]any{"ids": []string{"Yw", "YQ"}, "all": true}).results(false)
	if got := summary(res); !slices.Equal(got, []string{"Yw:alice:unshared", "YQ:carol:unshared"}) {
		t.Fatalf("admin unshare = %v", got)
	}

	res = root.do("POST", "/api/v1/admin/credentials/transfer", map[string]any{"ids": []string{"YQ", "Yg"}, "to": "carol", "keep_access": true}).results(false)
	if got := summary(res); !slices.Equal(got, []string{"YQ:alice>carol:transferred", "Yg:bob>carol:transferred"}) {
		t.Fatalf("admin transfer = %v", got)
	}
	if got := listIDs(w.as("alice"), "/api/v1/credentials?access=shared"); !slices.Equal(got, []string{"YQ"}) {
		t.Fatalf("alice kept access to %v", got)
	}
	if ev := w.audit("credential.transfer"); len(ev) != 2 || ev[0].Actor.Username != "root" || ev[0].Subject.Username != "bob" {
		t.Fatalf("transfer events = %+v", ev)
	}

	// Batch delete deletes, even credentials shared with the administrator.
	w.shareWith("carol", "Yw", "root")
	res = root.do("POST", "/api/v1/admin/credentials/batch-delete", map[string]any{"ids": []string{"YQ", "Yw", "Yg"}}).results(false)
	if got := summary(res); !slices.Equal(got, []string{"YQ:deleted", "Yw:deleted", "Yg:deleted"}) {
		t.Fatalf("admin batch-delete = %v", got)
	}
	if got := listIDs(w.as("carol"), "/api/v1/credentials"); len(got) != 0 {
		t.Fatalf("carol's credentials = %v", got)
	}
	if got := root.do("POST", "/api/v1/admin/credentials/batch-delete", map[string]any{"ids": []string{"YQ"}}).items(); !slices.Equal(got, []string{"ids[0]=YQ:not_found"}) {
		t.Fatalf("delete again = %v", got)
	}
}

func TestAdminUserCredentials(t *testing.T) {
	w := newWorld(t)
	w.register("bob", "Ym9i", "b.com", "Mg")
	w.register("alice", "YWxpY2U", "a.com", "MQ")
	w.shareWith("alice", "YWxpY2U", "bob", "carol")
	root := w.as("root")
	bobPath := fmt.Sprintf("/api/v1/admin/users/%d/credentials", w.bob.ID)

	creds := root.do("GET", bobPath, nil).accessCredentials()
	if len(creds) != 2 {
		t.Fatalf("bob's credentials = %+v", creds)
	}
	shared, owned := creds[0], creds[1]
	if shared.ID != "YWxpY2U" || *shared.Access != "shared" || shared.SharedAt == nil || *shared.Owner != brief(w.alice) ||
		shared.SharedWith == nil || len(*shared.SharedWith) != 2 {
		t.Fatalf("shared, as the admin sees it = %+v", shared)
	}
	if owned.ID != "Ym9i" || *owned.Access != "owner" || owned.SharedAt != nil || owned.SharedWith == nil {
		t.Fatalf("owned, as the admin sees it = %+v", owned)
	}
	if got := listIDs(root, bobPath+"?access=owned"); !slices.Equal(got, []string{"Ym9i"}) {
		t.Fatalf("access=owned = %v", got)
	}
	if got := listIDs(root, bobPath+"?access=shared&rp_id=A.COM"); !slices.Equal(got, []string{"YWxpY2U"}) {
		t.Fatalf("access=shared = %v", got)
	}
	root.do("GET", bobPath+"?access=bogus", nil).expectError(http.StatusBadRequest, "invalid_request")

	// Deleting a shared credential under bob only revokes bob's share.
	root.do("DELETE", bobPath+"/YWxpY2U", nil).expect(http.StatusNoContent)
	root.do("DELETE", bobPath+"/YWxpY2U", nil).expectError(http.StatusNotFound, "not_found")
	if got := listIDs(w.as("alice"), "/api/v1/credentials"); !slices.Equal(got, []string{"YWxpY2U"}) {
		t.Fatalf("alice lost her credential: %v", got)
	}
	if got := listIDs(w.as("carol"), "/api/v1/credentials"); !slices.Equal(got, []string{"YWxpY2U"}) {
		t.Fatalf("carol lost her share: %v", got)
	}
	ev := w.audit("credential.unshare")
	if len(ev) != 1 || ev[0].Actor.Username != "root" || ev[0].Subject.Username != "alice" || ev[0].Target.Username != "bob" {
		t.Fatalf("unshare events = %+v", ev)
	}
	// Deleting an owned one deletes it; a credential of someone else is 404.
	root.do("DELETE", bobPath+"/Ym9i", nil).expect(http.StatusNoContent)
	root.do("DELETE", fmt.Sprintf("/api/v1/admin/users/%d/credentials/YWxpY2U", w.root.ID), nil).expectError(http.StatusNotFound, "not_found")
	if n := len(listIDs(w.as("bob"), "/api/v1/credentials")); n != 0 {
		t.Fatalf("bob still has %d credentials", n)
	}
}
