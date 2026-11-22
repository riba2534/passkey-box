package api_test

import (
	"bytes"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/riba2534/passkey-box/server/internal/api"
)

func TestHealthAndInfo(t *testing.T) {
	e := newEnv(t)
	var health map[string]any
	e.anon().do("GET", "/healthz", nil).expect(http.StatusOK).decode(&health)
	if health["status"] != "ok" || health["version"] != "test-version" {
		t.Fatalf("healthz = %v", health)
	}

	r := e.anon().do("GET", "/api/v1/info", nil).expect(http.StatusOK)
	if ct := r.header.Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", ct)
	}
	var info map[string]any
	r.decode(&info)
	if info["version"] != "test-version" || info["allow_register"] != false || info["extension_download"] != false {
		t.Fatalf("info = %v", info)
	}
}

func TestUnknownAPIPathIsJSON404(t *testing.T) {
	e := newEnv(t)
	e.anon().do("GET", "/api/v1/nope", nil).expectError(http.StatusNotFound, "not_found")
	e.anon().do("GET", "/api/v2/credentials", nil).expectError(http.StatusNotFound, "not_found")
}

func TestCORS(t *testing.T) {
	e := newEnv(t)
	req, _ := http.NewRequest("OPTIONS", e.srv.URL+"/api/v1/credentials/abc", nil)
	req.Header.Set("Origin", "https://example.com")
	req.Header.Set("Access-Control-Request-Method", "DELETE")
	req.Header.Set("Access-Control-Request-Headers", "authorization, content-type")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("preflight status = %d", res.StatusCode)
	}
	checkCORS(t, res.Header)
	if !strings.Contains(res.Header.Get("Access-Control-Allow-Methods"), "PATCH") {
		t.Fatalf("methods = %q", res.Header.Get("Access-Control-Allow-Methods"))
	}

	// Actual responses, including errors, carry the CORS headers as well.
	checkCORS(t, e.anon().do("GET", "/api/v1/info", nil).expect(http.StatusOK).header)
	checkCORS(t, e.anon().do("GET", "/api/v1/me", nil).expect(http.StatusUnauthorized).header)
}

func checkCORS(t *testing.T, h http.Header) {
	t.Helper()
	if got := h.Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("Allow-Origin = %q", got)
	}
	if got := h.Get("Access-Control-Allow-Headers"); got != "Authorization, Content-Type" {
		t.Fatalf("Allow-Headers = %q", got)
	}
	if got := h.Get("Access-Control-Allow-Methods"); got != "GET, POST, PUT, PATCH, DELETE, OPTIONS" {
		t.Fatalf("Allow-Methods = %q", got)
	}
}

func TestExtensionDownload(t *testing.T) {
	const path = "/downloads/passkey-box-extension.zip"

	extensionDownload := func(e *env) bool {
		var info map[string]any
		e.anon().do("GET", "/api/v1/info", nil).expect(http.StatusOK).decode(&info)
		return info["extension_download"] == true
	}

	t.Run("not configured", func(t *testing.T) {
		e := newEnv(t)
		e.anon().do("GET", path, nil).expectError(http.StatusNotFound, "not_found")
		if extensionDownload(e) {
			t.Fatal("extension_download = true")
		}
	})

	t.Run("missing file", func(t *testing.T) {
		missing := filepath.Join(t.TempDir(), "missing.zip")
		e := newEnv(t, func(o *api.Options) { o.ExtensionZip = missing })
		e.anon().do("GET", path, nil).expectError(http.StatusNotFound, "not_found")
		if extensionDownload(e) {
			t.Fatal("extension_download = true")
		}
	})

	t.Run("directory", func(t *testing.T) {
		e := newEnv(t, func(o *api.Options) { o.ExtensionZip = t.TempDir() })
		e.anon().do("GET", path, nil).expectError(http.StatusNotFound, "not_found")
	})

	t.Run("available", func(t *testing.T) {
		zip := filepath.Join(t.TempDir(), "ext.zip")
		content := "PK\x03\x04fake zip content"
		if err := os.WriteFile(zip, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		e := newEnv(t, func(o *api.Options) { o.ExtensionZip = zip })
		r := e.anon().do("GET", path, nil).expect(http.StatusOK)
		if string(r.body) != content {
			t.Fatalf("body = %q", r.body)
		}
		if ct := r.header.Get("Content-Type"); ct != "application/zip" {
			t.Fatalf("Content-Type = %q", ct)
		}
		if cd := r.header.Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment") || !strings.Contains(cd, "passkey-box-extension.zip") {
			t.Fatalf("Content-Disposition = %q", cd)
		}
		if !extensionDownload(e) {
			t.Fatal("extension_download = false")
		}
	})
}

func TestWebConsole(t *testing.T) {
	e := newEnv(t)
	r := e.anon().do("GET", "/", nil).expect(http.StatusOK)
	const entry = `<script type="module" src="/assets/js/main.js">`
	if !strings.HasPrefix(r.header.Get("Content-Type"), "text/html") || !strings.Contains(string(r.body), entry) {
		t.Fatalf("index: %s %s", r.header.Get("Content-Type"), r.body)
	}
	for _, p := range []string{
		"/assets/app.css", "/assets/admin.css", "/assets/user.css", "/assets/manifest.json", "/assets/logo-128.png",
		"/assets/favicon.ico", "/assets/favicon-32.png", "/assets/apple-touch-icon.png",
		"/assets/icon-192.png", "/assets/icon-512.png", "/assets/icon-maskable-512.png",
	} {
		e.anon().do("GET", p, nil).expect(http.StatusOK)
	}
	// Every asset the page and the manifest point at must exist.
	index := string(r.body)
	for _, p := range []string{
		"/assets/favicon.ico", "/assets/favicon-32.png", "/assets/apple-touch-icon.png", "/assets/manifest.json",
		"/assets/app.css", "/assets/admin.css", "/assets/user.css",
	} {
		if !strings.Contains(index, p) {
			t.Errorf("index.html does not reference %s", p)
		}
	}

	// Follow the imports from the entry module: each must load as JavaScript
	// (browsers refuse modules with another type), and every file under
	// assets/js must be reachable, so a missing or orphaned module fails here.
	importRE := regexp.MustCompile(`\bfrom\s*['"](\.{1,2}/[^'"]+)['"]`)
	modules := map[string]bool{}
	queue := []string{"/assets/js/main.js"}
	for len(queue) > 0 {
		p := queue[0]
		queue = queue[1:]
		if modules[p] {
			continue
		}
		modules[p] = true
		m := e.anon().do("GET", p, nil)
		if m.status != http.StatusOK {
			t.Errorf("GET %s: status = %d", p, m.status)
			continue
		}
		if ct := m.header.Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
			t.Errorf("%s: Content-Type = %q", p, ct)
		}
		for _, imp := range importRE.FindAllStringSubmatch(string(m.body), -1) {
			queue = append(queue, path.Join(path.Dir(p), imp[1]))
		}
	}
	err := filepath.WalkDir("../web/static/assets/js", func(file string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel("../web/static", file)
		if err != nil {
			return err
		}
		if p := "/" + filepath.ToSlash(rel); !modules[p] {
			t.Errorf("%s is not imported by any module", p)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	fav := e.anon().do("GET", "/favicon.ico", nil).expect(http.StatusOK)
	if !bytes.Equal(fav.body[:4], []byte{0, 0, 1, 0}) {
		t.Errorf("/favicon.ico is not an ICO file: % x", fav.body[:4])
	}
	e.anon().do("GET", "/assets/", nil).expect(http.StatusNotFound)
	e.anon().do("GET", "/missing", nil).expect(http.StatusNotFound)
	e.anon().do("POST", "/", nil).expect(http.StatusMethodNotAllowed)
}
