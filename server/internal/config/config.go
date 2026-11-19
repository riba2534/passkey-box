// Package config reads the server configuration from environment variables.
package config

import (
	"fmt"
	"strconv"
	"strings"
)

// Config holds the server settings documented in docs/API.md.
type Config struct {
	Listen        string // PKB_LISTEN
	DBPath        string // PKB_DB
	AdminUsername string // PKB_ADMIN_USERNAME
	AdminPassword string // PKB_ADMIN_PASSWORD
	AllowRegister bool   // PKB_ALLOW_REGISTER
	CookieSecure  bool   // PKB_COOKIE_SECURE
	ExtensionZip  string // PKB_EXTENSION_ZIP
}

// Load builds a Config from getenv (normally os.Getenv), applying defaults.
func Load(getenv func(string) string) (Config, error) {
	c := Config{
		Listen:        orDefault(getenv("PKB_LISTEN"), ":8080"),
		DBPath:        orDefault(getenv("PKB_DB"), "./data/passkey-box.db"),
		AdminUsername: getenv("PKB_ADMIN_USERNAME"),
		AdminPassword: getenv("PKB_ADMIN_PASSWORD"),
		ExtensionZip:  strings.TrimSpace(getenv("PKB_EXTENSION_ZIP")),
	}
	var err error
	if c.AllowRegister, err = parseBool("PKB_ALLOW_REGISTER", getenv("PKB_ALLOW_REGISTER")); err != nil {
		return Config{}, err
	}
	if c.CookieSecure, err = parseBool("PKB_COOKIE_SECURE", getenv("PKB_COOKIE_SECURE")); err != nil {
		return Config{}, err
	}
	return c, nil
}

// BootstrapAdmin reports whether both admin variables are set.
func (c Config) BootstrapAdmin() bool {
	return c.AdminUsername != "" && c.AdminPassword != ""
}

func orDefault(v, def string) string {
	if v = strings.TrimSpace(v); v == "" {
		return def
	}
	return v
}

func parseBool(name, v string) (bool, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return false, nil
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return false, fmt.Errorf("%s: invalid boolean %q", name, v)
	}
	return b, nil
}
