package main

import (
	"encoding/json"
	"testing"
)

func TestProviderRegionCannotChangeDestination(t *testing.T) {
	for _, region := range []string{"cn-north-4@127.0.0.1/#", "../metadata", "cn-north-4/path"} {
		credentials, _ := json.Marshal(map[string]string{"access_key_id": "test", "secret_access_key": "test", "region_id": region})
		if _, err := providerFor(dnsParams{Provider: "huaweicloud", Credentials: credentials}); err == nil {
			t.Fatalf("accepted unsafe region %q", region)
		}
	}
	if _, err := providerFor(dnsParams{Provider: "huaweicloud", Credentials: json.RawMessage(`{"access_key_id":"test","secret_access_key":"test","region_id":"cn-north-4"}`)}); err != nil {
		t.Fatal(err)
	}
}
