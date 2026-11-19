package config

import "testing"

func envOf(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestDefaults(t *testing.T) {
	c, err := Load(envOf(nil))
	if err != nil {
		t.Fatal(err)
	}
	want := Config{Listen: ":8080", DBPath: "./data/passkey-box.db"}
	if c != want {
		t.Fatalf("defaults = %+v, want %+v", c, want)
	}
	if c.BootstrapAdmin() {
		t.Fatal("BootstrapAdmin without variables")
	}
}

func TestValues(t *testing.T) {
	c, err := Load(envOf(map[string]string{
		"PKB_LISTEN":         "127.0.0.1:9000",
		"PKB_DB":             "/data/pkb.db",
		"PKB_ADMIN_USERNAME": "admin",
		"PKB_ADMIN_PASSWORD": "secret",
		"PKB_ALLOW_REGISTER": "true",
		"PKB_COOKIE_SECURE":  "1",
		"PKB_EXTENSION_ZIP":  "/srv/ext.zip",
	}))
	if err != nil {
		t.Fatal(err)
	}
	want := Config{
		Listen: "127.0.0.1:9000", DBPath: "/data/pkb.db",
		AdminUsername: "admin", AdminPassword: "secret",
		AllowRegister: true, CookieSecure: true, ExtensionZip: "/srv/ext.zip",
	}
	if c != want {
		t.Fatalf("config = %+v, want %+v", c, want)
	}
	if !c.BootstrapAdmin() {
		t.Fatal("BootstrapAdmin = false")
	}
}

func TestBootstrapNeedsBothVariables(t *testing.T) {
	for _, env := range []map[string]string{
		{"PKB_ADMIN_USERNAME": "admin"},
		{"PKB_ADMIN_PASSWORD": "secret"},
	} {
		c, err := Load(envOf(env))
		if err != nil || c.BootstrapAdmin() {
			t.Fatalf("%v: BootstrapAdmin = %v, err %v", env, c.BootstrapAdmin(), err)
		}
	}
}

func TestInvalidBoolean(t *testing.T) {
	for _, k := range []string{"PKB_ALLOW_REGISTER", "PKB_COOKIE_SECURE"} {
		if _, err := Load(envOf(map[string]string{k: "maybe"})); err == nil {
			t.Fatalf("%s=maybe: expected an error", k)
		}
	}
}
