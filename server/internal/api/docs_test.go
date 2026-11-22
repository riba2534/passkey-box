package api_test

import (
	"os"
	"strings"
	"testing"

	"github.com/riba2534/passkey-box/server/internal/api"
)

// Every route must be documented in docs/API.md as "METHOD /path".
func TestRoutesAreDocumented(t *testing.T) {
	doc, err := os.ReadFile("../../../docs/API.md")
	if err != nil {
		t.Fatal(err)
	}
	patterns := api.New(api.Options{}).Patterns()
	if len(patterns) < 40 {
		t.Fatalf("only %d routes", len(patterns))
	}
	for _, p := range patterns {
		if !strings.Contains(string(doc), p) {
			t.Errorf("docs/API.md does not document %q", p)
		}
	}
}
