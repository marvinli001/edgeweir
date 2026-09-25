package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func call(t *testing.T, input string) (Response, int) {
	t.Helper()
	var out bytes.Buffer
	code := run(strings.NewReader(input), &out)
	var resp Response
	if err := json.Unmarshal(out.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON output %q: %v", out.String(), err)
	}
	return resp, code
}

func TestVersionAndProviders(t *testing.T) {
	resp, code := call(t, `{"command":"version"}`)
	if code != 0 || !resp.OK {
		t.Fatalf("version failed: %+v", resp)
	}
	resp, code = call(t, `{"command":"providers"}`)
	if code != 0 || !resp.OK {
		t.Fatalf("providers failed: %+v", resp)
	}
}

func TestRejectsUnknownAndMalformed(t *testing.T) {
	if resp, code := call(t, `{"command":"nope"}`); code == 0 || resp.OK {
		t.Fatalf("unknown command accepted: %+v", resp)
	}
	if resp, code := call(t, `{"command":"version","extra":1}`); code != 2 || resp.OK {
		t.Fatalf("unknown field accepted: %+v", resp)
	}
	if resp, code := call(t, `{"command":"obtain"}`); code == 0 || !strings.Contains(resp.Error, "not implemented") {
		t.Fatalf("obtain should be a clear stub: %+v", resp)
	}
}
