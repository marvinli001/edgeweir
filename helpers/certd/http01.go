package main

import (
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/go-acme/lego/v4/acme"
	"github.com/go-acme/lego/v4/acme/api"
	"github.com/go-acme/lego/v4/challenge"
)

// httpValidations is how many HTTP-01 challenges the CA is asked to
// validate at once.
const httpValidations = 4

// httpToken is one HTTP-01 challenge in the console protocol.
type httpToken struct {
	Domain           string `json:"domain"`
	Token            string `json:"token"`
	KeyAuthorization string `json:"keyAuthorization,omitempty"`
}

// httpResolver answers all HTTP-01 challenges of an order at once: one
// "http01.present" event carries them (the console publishes them in one
// revision and waits for its nodes once), then the CA validates them a few
// at a time, and one "http01.cleanup" event ends them. lego's own HTTP-01
// solver presents, validates and cleans up one name after another, which
// costs the console two publications per name.
type httpResolver struct {
	core    *api.Core
	session *protocolSession
}

func (r *httpResolver) Solve(authorizations []acme.Authorization) error {
	var challenges []acme.Challenge
	var tokens []httpToken
	for _, authz := range authorizations {
		if authz.Status == acme.StatusValid {
			continue // validated recently; the CA reuses the authorization
		}
		chlg, err := challenge.FindChallenge(challenge.HTTP01, authz)
		if err != nil {
			return err
		}
		keyAuth, err := r.core.GetKeyAuthorization(chlg.Token)
		if err != nil {
			return err
		}
		chlg.KeyAuthorization = keyAuth
		challenges = append(challenges, chlg)
		tokens = append(tokens, httpToken{Domain: authz.Identifier.Value, Token: chlg.Token, KeyAuthorization: keyAuth})
	}
	if len(challenges) == 0 {
		return nil
	}
	if err := r.session.event(map[string]any{"event": "http01.present", "challenges": tokens}); err != nil {
		return err
	}
	defer func() {
		for i := range tokens {
			tokens[i].KeyAuthorization = ""
		}
		// Only tidies up: the challenges expire and end with the attempt anyway.
		_ = r.session.event(map[string]any{"event": "http01.cleanup", "challenges": tokens})
	}()
	errs := make([]error, len(challenges))
	slots := make(chan struct{}, httpValidations)
	var wg sync.WaitGroup
	for i, chlg := range challenges {
		slots <- struct{}{}
		wg.Go(func() {
			defer func() { <-slots }()
			if err := validateChallenge(r.core, chlg, 2*time.Minute); err != nil {
				errs[i] = fmt.Errorf("[%s] %w", tokens[i].Domain, err)
			}
		})
	}
	wg.Wait()
	return errors.Join(errs...)
}

var errValidationTimeout = coded("acme_validation_timeout", errors.New("the CA did not validate the challenge in time"))

// validateChallenge asks the CA to validate a challenge and polls its
// authorization until it is decided, as lego's own validation does.
func validateChallenge(core *api.Core, chlg acme.Challenge, limit time.Duration) error {
	started, err := core.Challenges.New(chlg.URL)
	if err != nil {
		return fmt.Errorf("failed to initiate challenge: %w", err)
	}
	switch started.Status {
	case acme.StatusValid:
		return nil
	case acme.StatusInvalid:
		return fmt.Errorf("invalid challenge: %w", started.Err())
	}
	delay, err := api.ParseRetryAfter(started.RetryAfter)
	if err != nil || delay <= 0 || delay > 10*time.Second {
		delay = 2 * time.Second
	}
	deadline := time.Now().Add(limit)
	for {
		time.Sleep(delay)
		authz, err := core.Authorizations.Get(started.AuthorizationURL)
		if err != nil {
			return err
		}
		switch authz.Status {
		case acme.StatusValid:
			return nil
		case acme.StatusPending, acme.StatusProcessing:
		default:
			for _, c := range authz.Challenges {
				if c.Status == acme.StatusInvalid && c.Error != nil {
					return fmt.Errorf("invalid authorization: %w", c.Err())
				}
			}
			return fmt.Errorf("the authorization is %s", authz.Status)
		}
		if time.Now().After(deadline) {
			return errValidationTimeout
		}
		delay = min(delay*3/2, 10*time.Second)
	}
}
