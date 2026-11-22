package api_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/riba2534/passkey-box/server/internal/store"
)

type fieldJSON struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Type  string `json:"type"`
	Value string `json:"value"`
}

// editJSON is the editable part of a credential.
type editJSON struct {
	ID              string       `json:"id"`
	RPName          string       `json:"rp_name"`
	UserName        string       `json:"user_name"`
	UserDisplayName string       `json:"user_display_name"`
	Label           string       `json:"label"`
	Fields          *[]fieldJSON `json:"fields"`
}

func (r *response) edited() editJSON {
	r.t.Helper()
	var body struct {
		Credential editJSON `json:"credential"`
	}
	r.expect(http.StatusOK).decode(&body)
	if body.Credential.Fields == nil {
		r.t.Fatalf("no fields list in %s", r.body)
	}
	return body.Credential
}

// errorMessage checks a 400 invalid_request and returns its message.
func (r *response) errorMessage() string {
	r.t.Helper()
	r.expectPlainError()
	var body struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	r.decode(&body)
	return body.Error.Message
}

func TestPatchCredentialNamesAndFields(t *testing.T) {
	w := newWorld(t)
	w.register("alice", "YQ", "github.com", "MQ")
	alice := w.as("alice")

	got := alice.do("PATCH", "/api/v1/credentials/YQ", map[string]any{
		"rp_name":   " GitHub（公司） ",
		"user_name": "alice@example.com", // unchanged
		"fields": []map[string]string{
			{"label": "恢复码", "type": "password", "value": "abcd-efgh"},
			{"label": "2FA", "type": "totp", "value": "otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub"},
			{"id": "bad id!", "label": "", "type": "date", "value": "2026-11-23"},
		},
	}).edited()
	fields := *got.Fields
	if got.RPName != "GitHub（公司）" || got.UserName != "alice@example.com" || got.UserDisplayName != "Alice" || got.Label != "" ||
		len(fields) != 3 || fields[0] != (fieldJSON{fields[0].ID, "恢复码", "password", "abcd-efgh"}) || fields[2].Type != "date" {
		t.Fatalf("patched = %+v", got)
	}
	for _, f := range fields {
		if len(f.ID) != 8 {
			t.Fatalf("field id %q", f.ID)
		}
	}
	// Only the label: what 0.6.0 clients send. The rest stays.
	relabeled := alice.do("PATCH", "/api/v1/credentials/YQ", map[string]string{"label": "工作号"}).edited()
	if relabeled.Label != "工作号" || relabeled.RPName != "GitHub（公司）" || !slices.Equal(*relabeled.Fields, fields) {
		t.Fatalf("relabeled = %+v", relabeled)
	}
	// Fields keep their IDs; an empty list removes them all.
	moved := alice.do("PATCH", "/api/v1/credentials/YQ", map[string]any{"fields": []fieldJSON{fields[2], fields[0]}}).edited()
	if !slices.Equal(*moved.Fields, []fieldJSON{fields[2], fields[0]}) {
		t.Fatalf("moved = %+v", moved.Fields)
	}

	var events []string
	for _, e := range w.audit("credential.update") {
		events = append(events, fmt.Sprintf("%s %s", e.Via, e.Detail))
	}
	want := []string{
		`basic {"fields":{"added":[],"removed":["2FA"],"changed":[]}}`,
		`basic {"label":{"from":"","to":"工作号"}}`,
		`basic {"fields":{"added":["恢复码","2FA",""],"removed":[],"changed":[]},"rp_name":{"from":"Example","to":"GitHub（公司）"}}`,
	}
	if !slices.Equal(events, want) {
		t.Fatalf("events =\n%s\nwant\n%s", strings.Join(events, "\n"), strings.Join(want, "\n"))
	}
	for _, e := range w.events(store.AuditFilter{}) {
		if s := string(e.Detail); strings.Contains(s, "abcd-efgh") || strings.Contains(s, "JBSWY3DPEHPK3PXP") || strings.Contains(s, "2026-11-23") {
			t.Fatalf("%s event carries a field value: %s", e.Action, s)
		}
	}
	if cleared := alice.do("PATCH", "/api/v1/credentials/YQ", map[string]any{"fields": []any{}}).edited(); len(*cleared.Fields) != 0 {
		t.Fatalf("cleared = %+v", cleared.Fields)
	}
}

func TestPatchCredentialValidation(t *testing.T) {
	w := newWorld(t)
	w.register("alice", "YQ", "github.com", "MQ")
	alice := w.as("alice")
	long := strings.Repeat("长", 1001)
	many := make([]map[string]string, 51)
	for i := range many {
		many[i] = map[string]string{"type": "text"}
	}
	for body, want := range map[string]string{
		`{}`:                                    "nothing to update",
		`{"fields": null}`:                      "nothing to update",
		`{"unknown": "x"}`:                      "nothing to update",
		`{"rp_name": "` + long + `"}`:           "rp_name must be at most 1000 characters",
		`{"user_display_name": "` + long + `"}`: "user_display_name must be at most 1000 characters",
		`{"label": "x", "fields": [{"type": "text"}, {"type": "secret"}]}`:                              "fields[1]: type must be one of text, password, url, email, phone, date, multiline, totp",
		`{"fields": [{"type": "totp", "value": "GEZ"}]}`:                                                "fields[0]: invalid TOTP secret",
		`{"fields": [{"type": "totp", "value": "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=10"}]}`: "fields[0]: TOTP digits must be 6, 7 or 8",
		`{"fields": [{"type": "date", "value": "2026-02-30"}]}`:                                         "fields[0]: date must be a valid date in YYYY-MM-DD form",
		`{"fields": [{"type": "text", "label": "` + strings.Repeat("a", 101) + `"}]}`:                   "fields[0]: label must be at most 100 characters",
		`{"fields": [{"type": "text", "value": "` + strings.Repeat("a", 10001) + `"}]}`:                 "fields[0]: value must be at most 10000 characters",
		`{"fields": [null]}`:                         "fields[0]: type must be one of text, password, url, email, phone, date, multiline, totp",
		`{"fields": {"type": "text"}}`:               "invalid JSON body",
		`{"fields": [{"type": "text", "value": 1}]}`: "invalid JSON body",
		`{"label": 1}`:                               "invalid JSON body",
		`{`:                                          "invalid JSON body",
	} {
		if got := alice.do("PATCH", "/api/v1/credentials/YQ", body).errorMessage(); got != want {
			t.Errorf("%.80s: %q, want %q", body, got, want)
		}
	}
	if got := alice.do("PATCH", "/api/v1/credentials/YQ", map[string]any{"fields": many}).errorMessage(); got != "fields[50]: at most 50 fields are allowed" {
		t.Errorf("51 fields: %q", got)
	}
	// Validation comes before the lookup, as for the label before.
	w.as("carol").do("PATCH", "/api/v1/credentials/YQ", `{}`).expectPlainError()
	w.as("root").do("PATCH", "/api/v1/admin/credentials/bm9uZQ", `{"fields": [{"type": "x"}]}`).expectPlainError()
	if got := w.as("root").do("PATCH", "/api/v1/admin/credentials/YQ", `{"user_name": "`+long+`"}`).errorMessage(); got != "user_name must be at most 1000 characters" {
		t.Errorf("admin: %q", got)
	}
	// The limits themselves are fine.
	alice.do("PATCH", "/api/v1/credentials/YQ", map[string]any{"rp_name": strings.Repeat("长", 1000), "fields": many[:50]}).expect(http.StatusOK)
	if got := alice.do("GET", "/api/v1/credentials/YQ", nil).edited(); len(*got.Fields) != 50 || got.Label != "" {
		t.Fatalf("after the refused requests = %+v", got)
	}
	if n := len(w.audit("credential.update")); n != 1 {
		t.Fatalf("%d update events", n)
	}
}

func TestPatchCredentialPermissions(t *testing.T) {
	w := newWorld(t)
	w.register("alice", "YQ", "github.com", "MQ")
	w.shareWith("alice", "YQ", "bob")
	body := map[string]any{"user_display_name": "Team", "fields": []fieldJSON{{Label: "PIN", Type: "password", Value: "1234"}}}

	w.as("bob").do("PATCH", "/api/v1/credentials/YQ", body).expectError(http.StatusForbidden, "forbidden")
	w.as("carol").do("PATCH", "/api/v1/credentials/YQ", body).expectError(http.StatusNotFound, "not_found")
	w.as("root").do("PATCH", "/api/v1/credentials/YQ", body).expectError(http.StatusNotFound, "not_found")
	w.as("bob").do("PATCH", "/api/v1/admin/credentials/YQ", body).expectError(http.StatusForbidden, "forbidden")
	readOnly := w.bearer(w.createToken(w.alice.ID, "reader", true, nil))
	readOnly.do("PATCH", "/api/v1/credentials/YQ", body).expectError(http.StatusForbidden, "read_only_token")
	rootReader := w.bearer(w.createToken(w.root.ID, "audit", true, nil))
	rootReader.do("PATCH", "/api/v1/admin/credentials/YQ", body).expectError(http.StatusForbidden, "read_only_token")
	if n := len(w.audit("credential.update")); n != 0 {
		t.Fatalf("refused updates recorded %d events", n)
	}

	// The owner, with any authentication, and administrators may edit.
	token := w.bearer(w.createToken(w.alice.ID, "agent", false, nil))
	if got := token.do("PATCH", "/api/v1/credentials/YQ", body).edited(); got.UserDisplayName != "Team" || len(*got.Fields) != 1 {
		t.Fatalf("token edit = %+v", got)
	}
	var admin struct {
		Credential map[string]any `json:"credential"`
	}
	w.as("root").do("PATCH", "/api/v1/admin/credentials/YQ", map[string]any{"rp_name": "", "user_name": "a@corp.example"}).
		expect(http.StatusOK).decode(&admin)
	if admin.Credential["rp_name"] != "" || admin.Credential["user_name"] != "a@corp.example" || admin.Credential["private_key"] != nil ||
		len(admin.Credential["fields"].([]any)) != 1 || admin.Credential["shared_with"] == nil {
		t.Fatalf("admin edit = %v", admin.Credential)
	}
	var events []string
	for _, e := range w.audit("credential.update") {
		events = append(events, fmt.Sprintf("%s via %s on %s (%s) %s", e.Actor.Username, e.Via, e.Subject.Username, e.Credential.UserName, e.Detail))
	}
	want := []string{
		`root via basic on alice (alice@example.com) {"rp_name":{"from":"Example","to":""},"user_name":{"from":"alice@example.com","to":"a@corp.example"}}`,
		`alice via token:agent on alice (alice@example.com) {"fields":{"added":["PIN"],"removed":[],"changed":[]},"user_display_name":{"from":"Alice","to":"Team"}}`,
	}
	if !slices.Equal(events, want) {
		t.Fatalf("events =\n%s\nwant\n%s", strings.Join(events, "\n"), strings.Join(want, "\n"))
	}
}

// Every credential view carries fields, the values included, even for share
// recipients and tokens; batch results do not.
func TestFieldsInEveryCredentialView(t *testing.T) {
	w := newWorld(t)
	w.register("alice", "YQ", "github.com", "MQ")
	w.register("alice", "Yg", "gitlab.com", "Mg")
	w.shareWith("alice", "YQ", "bob")
	field := fieldJSON{Label: "Recovery", Type: "password", Value: "s3cret"}
	field.ID = (*w.as("alice").do("PATCH", "/api/v1/credentials/YQ", map[string]any{"fields": []fieldJSON{field}}).edited().Fields)[0].ID
	bobToken := w.bearer(w.createToken(w.bob.ID, "agent", true, nil))
	root := w.as("root")

	fieldsOf := func(r *response) map[string]string {
		t.Helper()
		var body struct {
			Credential  *map[string]json.RawMessage  `json:"credential"`
			Credentials []map[string]json.RawMessage `json:"credentials"`
		}
		r.decode(&body)
		if body.Credential != nil {
			body.Credentials = append(body.Credentials, *body.Credential)
		}
		out := map[string]string{}
		for _, c := range body.Credentials {
			var id string
			json.Unmarshal(c["id"], &id)
			out[id] = string(c["fields"])
		}
		return out
	}
	withField := `[{"id":"` + field.ID + `","label":"Recovery","type":"password","value":"s3cret"}]`
	for name, tc := range map[string]struct {
		r    *response
		want map[string]string
	}{
		"owner list":            {w.as("alice").do("GET", "/api/v1/credentials", nil).expect(http.StatusOK), map[string]string{"YQ": withField, "Yg": "[]"}},
		"owner get":             {w.as("alice").do("GET", "/api/v1/credentials/Yg", nil).expect(http.StatusOK), map[string]string{"Yg": "[]"}},
		"recipient list":        {w.as("bob").do("GET", "/api/v1/credentials?rp_id=github.com", nil).expect(http.StatusOK), map[string]string{"YQ": withField}},
		"recipient token":       {bobToken.do("GET", "/api/v1/credentials/YQ", nil).expect(http.StatusOK), map[string]string{"YQ": withField}},
		"admin list":            {root.do("GET", "/api/v1/admin/credentials", nil).expect(http.StatusOK), map[string]string{"YQ": withField, "Yg": "[]"}},
		"admin get":             {root.do("GET", "/api/v1/admin/credentials/YQ", nil).expect(http.StatusOK), map[string]string{"YQ": withField}},
		"admin user list":       {root.do("GET", fmt.Sprintf("/api/v1/admin/users/%d/credentials", w.bob.ID), nil).expect(http.StatusOK), map[string]string{"YQ": withField}},
		"admin q a field label": {root.do("GET", "/api/v1/admin/credentials?q=RECOV", nil).expect(http.StatusOK), map[string]string{"YQ": withField}},
		"admin q a field value": {root.do("GET", "/api/v1/admin/credentials?q=s3cret", nil).expect(http.StatusOK), map[string]string{}},
		"create":                {w.as("alice").do("POST", "/api/v1/credentials", newCred("Yw", "c.com", "Mw")).expect(http.StatusCreated), map[string]string{"Yw": "[]"}},
	} {
		if got := fieldsOf(tc.r); fmt.Sprint(got) != fmt.Sprint(tc.want) {
			t.Errorf("%s: fields = %v, want %v", name, got, tc.want)
		}
	}
	for _, r := range []*response{
		w.as("alice").do("POST", "/api/v1/credentials/share", map[string]any{"ids": []string{"YQ"}, "users": []string{"carol"}}),
		root.do("POST", "/api/v1/admin/credentials/transfer", map[string]any{"ids": []string{"YQ"}, "to": "carol", "dry_run": true}),
		w.as("bob").do("POST", "/api/v1/credentials/leave", map[string]any{"ids": []string{"YQ"}, "dry_run": true}),
	} {
		if r.expect(http.StatusOK); strings.Contains(string(r.body), "fields") || strings.Contains(string(r.body), "s3cret") {
			t.Errorf("batch result carries fields: %s", r.body)
		}
	}
}

func TestReRegisteringKeepsEditsAndFields(t *testing.T) {
	w := newWorld(t)
	w.register("alice", "b2xk", "github.com", "aGFuZGxl")
	alice := w.as("alice")
	before := alice.do("PATCH", "/api/v1/credentials/b2xk", map[string]any{
		"label": "工作号", "user_display_name": "Alice at work",
		"fields": []fieldJSON{{Label: "PIN", Type: "password", Value: "1234"}},
	}).edited()

	w.advance(time.Minute)
	body := newCred("bmV3", "GitHub.com", "aGFuZGxl")
	body["rp_name"], body["user_name"], body["user_display_name"] = "GitHub", "alice-renamed", "Alice R."
	var created struct {
		Credential editJSON `json:"credential"`
	}
	alice.do("POST", "/api/v1/credentials", body).expect(http.StatusCreated).decode(&created)
	got := created.Credential
	if got.ID != "bmV3" || got.Label != "工作号" || got.RPName != "GitHub" || got.UserName != "alice-renamed" ||
		got.UserDisplayName != "Alice at work" || got.Fields == nil || !slices.Equal(*got.Fields, *before.Fields) {
		t.Fatalf("re-registered = %+v", got)
	}
	// A label in the request wins.
	body["id"], body["label"] = "YWdhaW4", "new label"
	alice.do("POST", "/api/v1/credentials", body).expect(http.StatusCreated).decode(&created)
	if got := created.Credential; got.Label != "new label" || got.UserDisplayName != "Alice at work" || len(*got.Fields) != 1 {
		t.Fatalf("with a label = %+v", got)
	}
	if ids := listIDs(alice, "/api/v1/credentials"); !slices.Equal(ids, []string{"YWdhaW4"}) {
		t.Fatalf("credentials = %v", ids)
	}
}
