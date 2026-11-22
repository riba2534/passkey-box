package store

import (
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// fixture is a store with users and helpers to add credentials.
type fixture struct {
	t     *testing.T
	s     *Store
	users map[string]User
}

func newFixture(t *testing.T, names ...string) *fixture {
	t.Helper()
	f := &fixture{t: t, s: openTest(t), users: map[string]User{}}
	for _, n := range names {
		f.users[n] = mustUser(t, f.s, n, n == "root")
	}
	return f
}

func (f *fixture) actor(name string) Actor {
	return Actor{ID: f.users[name].ID, Name: name, Via: "session"}
}

// save registers a credential for owner at t0 plus offset.
func (f *fixture) save(owner, id, rpID, handle string, offset time.Duration) Credential {
	f.t.Helper()
	c, err := f.s.SaveCredential(f.t.Context(), f.actor(owner), f.users[owner].ID,
		Credential{ID: id, RPID: rpID, UserHandle: handle, UserName: id + "@example.com", PrivateKey: "a2V5", Alg: -7}, t0.Add(offset))
	if err != nil {
		f.t.Fatalf("save %s: %v", id, err)
	}
	return c
}

func (f *fixture) batch(actor string, ids ...string) CredentialBatch {
	return CredentialBatch{Actor: f.actor(actor), IDs: ids, Now: t0.Add(time.Hour)}
}

func (f *fixture) share(owner string, id string, users ...string) {
	f.t.Helper()
	keys := make([]UserKey, len(users))
	for i, u := range users {
		keys[i] = UserKey{Username: u}
	}
	if _, err := f.s.ShareCredentials(f.t.Context(), f.batch(owner, id), keys); err != nil {
		f.t.Fatalf("share %s: %v", id, err)
	}
}

func (f *fixture) get(id string) Credential {
	f.t.Helper()
	c, err := f.s.GetAnyCredential(f.t.Context(), id)
	if err != nil {
		f.t.Fatalf("get %s: %v", id, err)
	}
	return c
}

func shareNames(c Credential) []string {
	var out []string
	for _, sh := range c.Shares {
		out = append(out, sh.User.Username)
	}
	return out
}

func (f *fixture) auditCount(prefix string) int {
	f.t.Helper()
	ev, err := f.s.ListAudit(f.t.Context(), AuditFilter{Action: prefix, Limit: 1000})
	if err != nil {
		f.t.Fatal(err)
	}
	return len(ev)
}

func TestSaveCredentialDropsTheSharesOfReplacedCredentials(t *testing.T) {
	f := newFixture(t, "alice", "bob", "carol")
	ctx := t.Context()
	f.save("alice", "b2xk", "GitHub.com", "aA", 0)
	f.share("alice", "b2xk", "bob")
	f.share("alice", "b2xk", "carol")
	if err := f.s.MarkCredentialUsed(ctx, f.users["bob"].ID, "b2xk", t0.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	// Bob's own credential for the same account is not alice's to replace.
	f.save("bob", "Ym9i", "github.com", "aA", 0)

	// A conflicting ID rolls the replacement back: the old credential and
	// its shares survive.
	if _, err := f.s.SaveCredential(ctx, f.actor("alice"), f.users["alice"].ID,
		Credential{ID: "Ym9i", RPID: "github.com", UserHandle: "aA", PrivateKey: "a2V5", Alg: -7}, t0); !errors.Is(err, ErrConflict) {
		t.Fatalf("conflicting save = %v", err)
	}
	if got := shareNames(f.get("b2xk")); !slices.Equal(got, []string{"bob", "carol"}) {
		t.Fatalf("shares after the failed save = %v", got)
	}

	// The new private key reaches nobody until alice shares it again.
	fresh := f.save("alice", "bmV3", "github.com", "aA", 3*time.Hour)
	if fresh.Access != AccessOwner || fresh.Owner.Username != "alice" || len(fresh.Shares) != 0 {
		t.Fatalf("replacement = %+v", fresh)
	}
	if creds, _ := f.s.ListCredentials(ctx, f.users["carol"].ID, ""); len(creds) != 0 {
		t.Fatalf("carol still sees %+v", creds)
	}
	if _, err := f.s.GetAnyCredential(ctx, "b2xk"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old credential = %v", err)
	}
	if got := f.get("Ym9i"); got.Owner.Username != "bob" || len(got.Shares) != 0 {
		t.Fatalf("bob's credential = %+v", got)
	}
	ev, _ := f.s.ListAudit(ctx, AuditFilter{Action: "credential.create", Limit: 10})
	if len(ev) != 3 || ev[0].Credential.ID != "bmV3" || ev[0].Subject.Username != "alice" || ev[0].Via != "session" {
		t.Fatalf("create events = %+v", ev)
	}
}

func TestAccessibleCredentials(t *testing.T) {
	f := newFixture(t, "alice", "bob", "carol")
	ctx := t.Context()
	f.save("alice", "YQ", "a.com", "MQ", 0)
	f.save("bob", "Yg", "A.com", "Mg", time.Minute)
	f.save("carol", "Yw", "a.com", "Mw", 2*time.Minute)
	f.share("bob", "Yg", "alice", "carol")

	ids := func(fl AccessFilter) []string {
		creds, err := f.s.ListAccessibleCredentials(ctx, f.users["alice"].ID, fl)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, c := range creds {
			out = append(out, c.ID+":"+c.Access)
		}
		return out
	}
	for name, tc := range map[string]struct {
		f    AccessFilter
		want []string
	}{
		"all":    {AccessFilter{}, []string{"Yg:shared", "YQ:owner"}},
		"owned":  {AccessFilter{Access: AccessOwner}, []string{"YQ:owner"}},
		"shared": {AccessFilter{Access: AccessShared, RPID: "A.COM"}, []string{"Yg:shared"}},
		"rp_id":  {AccessFilter{RPID: "b.com"}, nil},
	} {
		if got := ids(tc.f); !slices.Equal(got, tc.want) {
			t.Errorf("%s: got %v, want %v", name, got, tc.want)
		}
	}

	c, err := f.s.GetCredential(ctx, f.users["alice"].ID, "Yg")
	if err != nil || c.Access != AccessShared || c.SharedAt == nil || !c.SharedAt.Equal(t0.Add(time.Hour)) ||
		c.Owner.Username != "bob" || c.PrivateKey != "a2V5" {
		t.Fatalf("shared credential = %+v, %v", c, err)
	}
	if _, err := f.s.GetCredential(ctx, f.users["alice"].ID, "Yw"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("carol's credential = %v", err)
	}

	// Recipients may use but not relabel; strangers may do neither.
	if _, err := f.s.UpdateCredential(ctx, f.actor("alice"), f.users["alice"].ID, "Yg", CredentialUpdate{Label: new("x")}, t0); !errors.Is(err, ErrForbidden) {
		t.Fatalf("recipient label = %v", err)
	}
	if _, err := f.s.UpdateCredential(ctx, f.actor("alice"), f.users["alice"].ID, "Yw", CredentialUpdate{Label: new("x")}, t0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stranger label = %v", err)
	}
	if err := f.s.MarkCredentialUsed(ctx, f.users["alice"].ID, "Yw", t0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stranger use = %v", err)
	}
	used := t0.Add(5 * time.Hour)
	if err := f.s.MarkCredentialUsed(ctx, f.users["alice"].ID, "Yg", used); err != nil {
		t.Fatal(err)
	}
	c = f.get("Yg")
	if c.UseCount != 1 || !c.LastUsedAt.Equal(used) || c.Shares[0].User.Username != "alice" ||
		!c.Shares[0].LastUsedAt.Equal(used) || c.Shares[1].LastUsedAt != nil {
		t.Fatalf("after use = %+v", c)
	}
	if f.auditCount("credential.update") != 0 {
		t.Fatal("refused label changes were recorded")
	}
}

func TestListAllCredentials(t *testing.T) {
	f := newFixture(t, "alice", "Bob", "carol")
	ctx := t.Context()
	f.save("alice", "YQ", "GitHub.com", "MQ", 0)
	f.save("alice", "Yg", "gitlab.com", "Mg", time.Minute)
	f.save("Bob", "Yw", "example.org", "Mw", 2*time.Minute)
	f.save("carol", "ZA", "github.com", "NA", 3*time.Minute)
	f.share("alice", "YQ", "Bob")
	f.share("carol", "ZA", "Bob", "alice")
	if _, err := f.s.AdminUpdateCredential(ctx, SystemActor, "Yw", CredentialUpdate{Label: new("Ünïcode Wörk")}, t0); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.AdminUpdateCredential(ctx, SystemActor, "Yg", CredentialUpdate{Fields: &[]Field{
		{Label: "Recovery Code", Type: "password", Value: "hunter2"}, {Type: "text", Value: "Sekret"}}}, t0); err != nil {
		t.Fatal(err)
	}

	yes, no := true, false
	list := func(fl CredentialFilter) ([]string, int) {
		if fl.Limit == 0 {
			fl.Limit = 100
		}
		creds, total, err := f.s.ListAllCredentials(ctx, fl)
		if err != nil {
			t.Fatal(err)
		}
		var ids []string
		for _, c := range creds {
			ids = append(ids, c.ID)
		}
		return ids, total
	}
	for name, tc := range map[string]struct {
		f    CredentialFilter
		want []string
	}{
		"all":                   {CredentialFilter{}, []string{"ZA", "Yw", "Yg", "YQ"}},
		"owner":                 {CredentialFilter{Owner: "ALICE"}, []string{"Yg", "YQ"}},
		"owner id":              {CredentialFilter{OwnerID: f.users["Bob"].ID}, []string{"Yw"}},
		"unknown owner":         {CredentialFilter{Owner: "nobody"}, nil},
		"invalid owner":         {CredentialFilter{Owner: string(make([]byte, 70))}, nil},
		"unknown owner id":      {CredentialFilter{OwnerID: 999}, nil},
		"shared with":           {CredentialFilter{SharedWith: "bob"}, []string{"ZA", "YQ"}},
		"shared with id":        {CredentialFilter{SharedWithID: f.users["alice"].ID}, []string{"ZA"}},
		"unknown shared with":   {CredentialFilter{SharedWith: "nobody"}, nil},
		"rp_id":                 {CredentialFilter{RPID: "GITHUB.com"}, []string{"ZA", "YQ"}},
		"q rp_id":               {CredentialFilter{Query: "GITLAB"}, []string{"Yg"}},
		"q user_name":           {CredentialFilter{Query: "zA@EXAMPLE"}, []string{"ZA"}},
		"q label":               {CredentialFilter{Query: "wörk"}, []string{"Yw"}},
		"q owner":               {CredentialFilter{Query: "caro"}, []string{"ZA"}},
		"q owner case":          {CredentialFilter{Query: "BO"}, []string{"Yw"}},
		"q field label":         {CredentialFilter{Query: "y CODE"}, []string{"Yg"}},
		"q not field values":    {CredentialFilter{Query: "hunter2"}, nil},
		"q not text values":     {CredentialFilter{Query: "sekret"}, nil},
		"q not field types":     {CredentialFilter{Query: "password"}, nil},
		"q percent is literal":  {CredentialFilter{Query: "%"}, nil},
		"q underscore literal":  {CredentialFilter{Query: "_"}, nil},
		"shared":                {CredentialFilter{Shared: &yes}, []string{"ZA", "YQ"}},
		"not shared":            {CredentialFilter{Shared: &no}, []string{"Yw", "Yg"}},
		"combined":              {CredentialFilter{Owner: "alice", Shared: &no}, []string{"Yg"}},
		"owner and id disagree": {CredentialFilter{Owner: "alice", OwnerID: f.users["Bob"].ID}, nil},
	} {
		if got, total := list(tc.f); !slices.Equal(got, tc.want) || total != len(tc.want) {
			t.Errorf("%s: got %v (total %d), want %v", name, got, total, tc.want)
		}
	}

	got, total := list(CredentialFilter{Limit: 2, Offset: 1})
	if !slices.Equal(got, []string{"Yw", "Yg"}) || total != 4 {
		t.Fatalf("page = %v, total %d", got, total)
	}
	if got, total := list(CredentialFilter{Limit: 2, Offset: 4}); got != nil || total != 4 {
		t.Fatalf("past the end = %v, total %d", got, total)
	}
	creds, _, _ := f.s.ListAllCredentials(ctx, CredentialFilter{RPID: "github.com", Limit: 10})
	if creds[0].Access != "" || !slices.Equal(shareNames(creds[0]), []string{"Bob", "alice"}) || shareNames(creds[1])[0] != "Bob" {
		t.Fatalf("shares = %+v", creds)
	}
}

func TestSharesGoWithCredentialAndUser(t *testing.T) {
	f := newFixture(t, "alice", "bob", "carol")
	ctx := t.Context()
	f.save("alice", "YQ", "a.com", "MQ", 0)
	f.save("alice", "Yg", "b.com", "Mg", 0)
	f.share("alice", "YQ", "bob", "carol")
	f.share("alice", "Yg", "bob")

	if err := f.s.DeleteCredential(ctx, f.actor("alice"), f.users["alice"].ID, "YQ", t0); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := f.s.db.QueryRow(`SELECT COUNT(*) FROM credential_shares`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("shares after deleting the credential = %d, %v", n, err)
	}
	if err := f.s.DeleteUser(ctx, SystemActor, f.users["bob"].ID, t0); err != nil {
		t.Fatal(err)
	}
	if got := f.get("Yg"); len(got.Shares) != 0 {
		t.Fatalf("shares after deleting the recipient = %+v", got.Shares)
	}

	// A share made by a since deleted administrator stays, without shared_by.
	root, _ := f.s.CreateUser(ctx, "root", "pw", true, t0)
	f.users["root"] = root
	b := f.batch("root", "Yg")
	b.Admin = true
	if _, err := f.s.ShareCredentials(ctx, b, []UserKey{{Username: "carol"}}); err != nil {
		t.Fatal(err)
	}
	if err := f.s.DeleteUser(ctx, SystemActor, root.ID, t0); err != nil {
		t.Fatal(err)
	}
	if got := f.get("Yg"); len(got.Shares) != 1 || got.Shares[0].User.Username != "carol" || got.Shares[0].SharedBy != nil {
		t.Fatalf("share by a deleted user = %+v", got.Shares)
	}
	if err := f.s.DeleteUser(ctx, SystemActor, f.users["alice"].ID, t0); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.GetAnyCredential(ctx, "Yg"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("alice's credential after deleting her = %v", err)
	}
	if err := f.s.db.QueryRow(`SELECT COUNT(*) FROM credential_shares`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("shares after deleting the owner = %d, %v", n, err)
	}
}

// updateEvents returns the credential.update events as "actor subject
// account detail", newest first.
func (f *fixture) updateEvents() []string {
	f.t.Helper()
	ev, err := f.s.ListAudit(f.t.Context(), AuditFilter{Action: "credential.update", Limit: 100})
	if err != nil {
		f.t.Fatal(err)
	}
	var out []string
	for _, e := range ev {
		out = append(out, fmt.Sprintf("%s %s %s %s", e.Actor.Username, e.Subject.Username, e.Credential.UserName, e.Detail))
	}
	return out
}

// row returns the stored names, label, edited columns and fields of a
// credential.
func (f *fixture) row(id string) string {
	f.t.Helper()
	var rpName, userName, displayName, label, edited, fields string
	if err := f.s.db.QueryRow(`SELECT rp_name, user_name, user_display_name, label, edited, fields FROM credentials WHERE id = ?`, id).
		Scan(&rpName, &userName, &displayName, &label, &edited, &fields); err != nil {
		f.t.Fatal(err)
	}
	return fmt.Sprintf("%q %q %q %q [%s] %s", rpName, userName, displayName, label, edited, fields)
}

func fieldIDs(fields []Field) []string {
	ids := []string{}
	for _, fl := range fields {
		ids = append(ids, fl.ID)
	}
	return ids
}

func TestUpdateCredential(t *testing.T) {
	f := newFixture(t, "alice", "bob", "carol", "root")
	ctx := t.Context()
	f.save("alice", "YQ", "github.com", "MQ", 0)
	f.share("alice", "YQ", "bob")
	update := func(actor string, u CredentialUpdate) (Credential, error) {
		return f.s.UpdateCredential(ctx, f.actor(actor), f.users[actor].ID, "YQ", u, t0.Add(time.Hour))
	}
	var inv *InvalidError
	for name, u := range map[string]CredentialUpdate{
		"nothing":        {},
		"long rp_name":   {RPName: new(strings.Repeat("名", MaxCredentialNameLen+1))},
		"long user_name": {UserName: new(strings.Repeat("a", MaxCredentialNameLen) + "b")},
		"long display":   {UserDisplayName: new(strings.Repeat("a", MaxCredentialNameLen+1)), Label: new("x")},
		"bad field":      {Label: new("x"), Fields: &[]Field{{Type: "text"}, {Type: "totp", Value: "GEZ"}}},
	} {
		if _, err := update("alice", u); !errors.As(err, &inv) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := update("alice", CredentialUpdate{}); err.Error() != "nothing to update" {
		t.Errorf("nothing: %v", err)
	}
	if _, err := update("alice", CredentialUpdate{UserName: new(strings.Repeat("a", MaxCredentialNameLen+1))}); err.Error() != "user_name must be at most 1000 characters" {
		t.Errorf("long user_name: %v", err)
	}
	if _, err := update("bob", CredentialUpdate{RPName: new("mine")}); !errors.Is(err, ErrForbidden) {
		t.Errorf("recipient = %v", err)
	}
	if _, err := update("carol", CredentialUpdate{Fields: &[]Field{}}); !errors.Is(err, ErrNotFound) {
		t.Errorf("stranger = %v", err)
	}
	if got := f.updateEvents(); len(got) != 0 || f.row("YQ") != `"" "YQ@example.com" "" "" [] []` {
		t.Fatalf("refused updates changed %s, events %v", f.row("YQ"), got)
	}

	// Only what changes is written; a name set to its value is not edited.
	c, err := update("alice", CredentialUpdate{
		RPName:   new(" GitHub（公司） \n"),
		UserName: new("YQ@example.com"),
		Fields: &[]Field{
			{Label: " 恢复码 ", Type: "password", Value: "abcd-efgh"},
			{Label: "2FA", Type: "totp", Value: " JBSWY3DPEHPK3PXP "},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if c.RPName != "GitHub（公司）" || c.UserName != "YQ@example.com" || c.edited != "rp_name" || len(c.Fields) != 2 ||
		c.Fields[0].Label != "恢复码" || c.Fields[1].Value != "JBSWY3DPEHPK3PXP" || len(c.Shares) != 1 || c.Access != AccessOwner {
		t.Fatalf("updated = %+v", c)
	}
	ids := fieldIDs(c.Fields)
	if len(ids[0]) != 8 || len(ids[1]) != 8 || ids[0] == ids[1] {
		t.Fatalf("field ids = %v", ids)
	}
	if stored := f.get("YQ"); !slices.Equal(stored.Fields, c.Fields) || stored.RPName != c.RPName || stored.edited != "rp_name" {
		t.Fatalf("stored = %+v", stored)
	}
	want := []string{`alice alice YQ@example.com {"fields":{"added":["恢复码","2FA"],"removed":[],"changed":[]},"rp_name":{"from":"","to":"GitHub（公司）"}}`}
	if got := f.updateEvents(); !slices.Equal(got, want) {
		t.Fatalf("events = %v\nwant     %v", got, want)
	}

	// The same values again change nothing and record nothing.
	same, err := update("alice", CredentialUpdate{RPName: new("GitHub（公司）"), Fields: &c.Fields, Label: new("")})
	if err != nil || !slices.Equal(same.Fields, c.Fields) || len(f.updateEvents()) != 1 {
		t.Fatalf("no-op update = %+v, %v, events %v", same, err, f.updateEvents())
	}

	// Fields keep their identity by ID: one changed, one removed, one added.
	c, err = update("alice", CredentialUpdate{
		Label:           new("工作号"),
		UserDisplayName: new("Alice"),
		Fields: &[]Field{
			{ID: "new-one", Label: "网址", Type: "url", Value: "https://github.com"},
			{ID: ids[0], Label: "恢复码", Type: "password", Value: "changed-secret"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := fieldIDs(c.Fields); !slices.Equal(got, []string{"new-one", ids[0]}) || c.edited != "rp_name,user_display_name" {
		t.Fatalf("fields = %+v, edited %q", c.Fields, c.edited)
	}
	want = append([]string{`alice alice YQ@example.com {"fields":{"added":["网址"],"removed":["2FA"],"changed":["恢复码"]},` +
		`"label":{"from":"","to":"工作号"},"user_display_name":{"from":"","to":"Alice"}}`}, want...)
	if got := f.updateEvents(); !slices.Equal(got, want) {
		t.Fatalf("events = %v\nwant     %v", got, want)
	}

	// A new order is a change with nothing added, removed or changed.
	reordered := []Field{c.Fields[1], c.Fields[0]}
	if c, err = update("alice", CredentialUpdate{Fields: &reordered}); err != nil || !slices.Equal(fieldIDs(c.Fields), []string{ids[0], "new-one"}) {
		t.Fatalf("reordered = %+v, %v", c, err)
	}
	want = append([]string{`alice alice YQ@example.com {"fields":{"added":[],"removed":[],"changed":[]}}`}, want...)
	if got := f.updateEvents(); !slices.Equal(got, want) {
		t.Fatalf("events = %v\nwant     %v", got, want)
	}

	// Administrators edit any credential; the event names the account as it
	// was. Clearing a name still marks it edited.
	c, err = f.s.AdminUpdateCredential(ctx, f.actor("root"), "YQ", CredentialUpdate{UserName: new("  "), Fields: &[]Field{}}, t0)
	if err != nil || c.UserName != "" || len(c.Fields) != 0 || c.Fields == nil || c.edited != "rp_name,user_name,user_display_name" ||
		len(c.Shares) != 1 || c.Access != "" {
		t.Fatalf("admin update = %+v, %v", c, err)
	}
	if got := f.updateEvents()[0]; got != `root alice YQ@example.com {"fields":{"added":[],"removed":["恢复码","网址"],"changed":[]},"user_name":{"from":"YQ@example.com","to":""}}` {
		t.Fatalf("admin event = %s", got)
	}
	if _, err := f.s.AdminUpdateCredential(ctx, f.actor("root"), "bm9uZQ", CredentialUpdate{Label: new("x")}, t0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("admin update of a missing credential = %v", err)
	}
	if got := f.row("YQ"); got != `"GitHub（公司）" "" "Alice" "工作号" [rp_name,user_name,user_display_name] []` {
		t.Fatalf("row = %s", got)
	}

	// Field values never reach the audit log.
	ev, _ := f.s.ListAudit(ctx, AuditFilter{Limit: 100})
	for _, e := range ev {
		for _, secret := range []string{"abcd-efgh", "changed-secret", "JBSWY3DPEHPK3PXP", "https://github.com"} {
			if strings.Contains(string(e.Detail), secret) {
				t.Errorf("%s event carries a field value: %s", e.Action, e.Detail)
			}
		}
	}
}

func TestDiffFields(t *testing.T) {
	from := []Field{{"a", "A", "text", "1"}, {"b", "B", "text", "2"}, {"c", "C", "text", "3"}, {"d", "D", "text", "4"}}
	to := []Field{{"d", "D", "text", "4"}, {"b", "B2", "text", "2"}, {"c", "C", "password", "3"}, {"a", "A", "text", "1!"}, {"e", "", "url", ""}}
	got := diffFields(from, to)
	if !slices.Equal(got.Added, []string{""}) || !slices.Equal(got.Removed, []string{}) || !slices.Equal(got.Changed, []string{"B2", "C", "A"}) {
		t.Fatalf("diff = %+v", got)
	}
	got = diffFields(from, nil)
	if !slices.Equal(got.Removed, []string{"A", "B", "C", "D"}) || len(got.Added) != 0 || got.Added == nil || got.Changed == nil {
		t.Fatalf("diff = %+v", got)
	}
}

// Registering the same account again replaces the passkey but keeps what the
// user made of the newest one it replaces.
func TestSaveCredentialKeepsWhatTheUserMade(t *testing.T) {
	f := newFixture(t, "alice", "bob")
	ctx := t.Context()
	register := func(owner, id, handle, label string, at time.Duration) (Credential, error) {
		return f.s.SaveCredential(ctx, f.actor(owner), f.users[owner].ID, Credential{ID: id, RPID: "GitHub.com", RPName: "GitHub",
			UserHandle: handle, UserName: "alice", UserDisplayName: "Alice", PrivateKey: "a2V5", Alg: -7, Label: label,
			Fields: []Field{{ID: "aWdub3Jl", Type: "text", Value: "ignored"}}}, t0.Add(at))
	}
	first, err := register("alice", "b2xk", "aA", "", 0)
	if err != nil || first.Fields == nil || len(first.Fields) != 0 || first.edited != "" {
		t.Fatalf("first = %+v, %v", first, err)
	}
	fields := []Field{{Label: "恢复码", Type: "password", Value: "abcd"}}
	edited, err := f.s.UpdateCredential(ctx, f.actor("alice"), f.users["alice"].ID, "b2xk",
		CredentialUpdate{Label: new("工作号"), RPName: new("GitHub（公司）"), Fields: &fields}, t0)
	if err != nil {
		t.Fatal(err)
	}

	// The site sends new names: the edited one stays, the others follow.
	fresh, err := f.s.SaveCredential(ctx, f.actor("alice"), f.users["alice"].ID, Credential{ID: "bmV3", RPID: "github.COM",
		RPName: "GitHub 2", UserHandle: "aA", UserName: "alice-new", UserDisplayName: "Alice New", PrivateKey: "bmV3", Alg: -7}, t0.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Label != "工作号" || fresh.RPName != "GitHub（公司）" || fresh.UserName != "alice-new" || fresh.UserDisplayName != "Alice New" ||
		!slices.Equal(fresh.Fields, edited.Fields) || fresh.edited != "rp_name" || fresh.PrivateKey != "bmV3" {
		t.Fatalf("re-registered = %+v", fresh)
	}
	if got := f.row("bmV3"); !strings.HasPrefix(got, `"GitHub（公司）" "alice-new" "Alice New" "工作号" [rp_name] [{"id":"`) {
		t.Fatalf("row = %s", got)
	}
	// A label in the request wins; the rest is kept again.
	again, err := register("alice", "YWdhaW4", "aA", "explicit", 2*time.Hour)
	if err != nil || again.Label != "explicit" || again.RPName != "GitHub（公司）" || again.UserName != "alice" ||
		!slices.Equal(again.Fields, edited.Fields) || again.edited != "rp_name" {
		t.Fatalf("with a label = %+v, %v", again, err)
	}
	// A conflicting ID changes nothing.
	f.save("bob", "Ym9i", "b.com", "bB", 0)
	if _, err := register("alice", "Ym9i", "aA", "", 3*time.Hour); !errors.Is(err, ErrConflict) {
		t.Fatalf("conflict = %v", err)
	}
	if got := f.get("YWdhaW4"); got.Label != "explicit" || !slices.Equal(got.Fields, edited.Fields) {
		t.Fatalf("after the conflict = %+v", got)
	}
	// Other accounts start empty, whatever fields the caller passes.
	other, err := register("alice", "b3RoZXI", "bB", "", 0)
	if err != nil || len(other.Fields) != 0 || other.Label != "" || other.RPName != "GitHub" || other.edited != "" {
		t.Fatalf("other account = %+v, %v", other, err)
	}
}

// Transfers can leave a user with two credentials for one account; the newest
// by creation time, then by insertion, is the one whose edits are kept.
func TestSaveCredentialKeepsTheNewestReplaced(t *testing.T) {
	f := newFixture(t, "alice", "bob")
	ctx := t.Context()
	label := func(owner, id, text string) {
		t.Helper()
		if _, err := f.s.UpdateCredential(ctx, f.actor(owner), f.users[owner].ID, id, CredentialUpdate{Label: &text,
			UserName: new(text), Fields: &[]Field{{Label: text, Type: "text"}}}, t0); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		bobAt, aliceAt time.Duration
		want           string
	}{
		// bob's credential is inserted first but created later.
		{5 * time.Hour, time.Hour, "bob's"},
		// Created at the same time: the later insertion wins.
		{time.Hour, time.Hour, "alice's"},
	} {
		handle := fmt.Sprintf("h%d", tc.bobAt)
		f.save("bob", "b"+handle, "a.com", handle, tc.bobAt)
		label("bob", "b"+handle, "bob's")
		f.save("alice", "a"+handle, "A.com", handle, tc.aliceAt)
		label("alice", "a"+handle, "alice's")
		if _, err := f.s.TransferCredentials(ctx, f.batch("bob", "b"+handle), UserKey{Username: "alice"}, false); err != nil {
			t.Fatal(err)
		}
		c := f.save("alice", "n"+handle, "a.com", handle, 6*time.Hour)
		if c.Label != tc.want || c.UserName != tc.want || len(c.Fields) != 1 || c.Fields[0].Label != tc.want {
			t.Errorf("bob at %v, alice at %v: kept %+v, want %s", tc.bobAt, tc.aliceAt, c, tc.want)
		}
		for _, id := range []string{"a" + handle, "b" + handle} {
			if _, err := f.s.GetAnyCredential(ctx, id); !errors.Is(err, ErrNotFound) {
				t.Errorf("replaced credential %s = %v", id, err)
			}
		}
	}
}

// Credentials migrated from schema 1 have no fields, as a list. So does a
// column set to JSON null by hand.
func TestMigratedCredentialsHaveNoFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pkb.db")
	writeV1Database(t, path)
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	mustExec(t, s.db, `UPDATE credentials SET fields = 'null' WHERE id = 'YQ'`)
	creds, _, err := s.ListAllCredentials(t.Context(), CredentialFilter{Limit: 10})
	if err != nil || len(creds) != 5 {
		t.Fatalf("credentials = %+v, %v", creds, err)
	}
	for _, c := range creds {
		if c.Fields == nil || len(c.Fields) != 0 || c.edited != "" {
			t.Errorf("%s: fields %#v, edited %q", c.ID, c.Fields, c.edited)
		}
	}
}
