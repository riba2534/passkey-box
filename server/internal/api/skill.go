package api

import (
	_ "embed"
	"io"
	"net/http"
	"regexp"
	"strings"
)

// skillTemplate is the agent guide served at /skill.md. "{{base_url}}" stands
// for the server address the client used.
//
//go:embed skill.md
var skillTemplate string

// validHost matches a host name or bracketed IPv6 address with an optional
// port. The Host header is client input and goes into the guide verbatim.
var validHost = regexp.MustCompile(`^([A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.?|\[[0-9A-Fa-f:.]+\])(:[0-9]{1,5})?$`)

// unknownHost stands in for a Host header that is not a plain host name. The
// .invalid domain never resolves, so an agent cannot send a token anywhere.
const unknownHost = "passkey-box.invalid"

// baseURL is the address the client reached the server at: the scheme from
// X-Forwarded-Proto (set by the reverse proxy) or the connection, and the host
// from the Host header.
func baseURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	switch p := strings.ToLower(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto"))); p {
	case "http", "https":
		scheme = p
	}
	host := r.Host
	if !validHost.MatchString(host) {
		host = unknownHost
	}
	return scheme + "://" + host
}

func (s *Server) handleSkill(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Content-Type", "text/markdown; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	io.WriteString(w, strings.ReplaceAll(skillTemplate, "{{base_url}}", baseURL(r)))
}
