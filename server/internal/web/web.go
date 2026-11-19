// Package web serves the embedded single-page web console.
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed static
var files embed.FS

// Handler serves index.html at "/", the files under static/assets at
// "/assets/" and /favicon.ico for clients that ignore the <link rel="icon">
// tags. Everything else is 404; the console uses hash routing.
func Handler() http.Handler {
	root, err := fs.Sub(files, "static")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServerFS(root)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		p := r.URL.Path
		if p == "/favicon.ico" {
			r = r.Clone(r.Context())
			r.URL.Path = "/assets/favicon.ico"
		} else if p != "/" && (!strings.HasPrefix(p, "/assets/") || strings.HasSuffix(p, "/")) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		fileServer.ServeHTTP(w, r)
	})
}
