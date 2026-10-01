-- A chain stored with other PEM blocks (a combined fullchain-and-key upload
-- put the private key there) keeps only its certificates.
UPDATE "certificate" SET "chain_pem" = coalesce((
	SELECT string_agg(t.m[1], E'\n' ORDER BY t.n) || E'\n'
	FROM regexp_matches("chain_pem", '(-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----)', 'g') WITH ORDINALITY AS t(m, n)
), '')
WHERE "chain_pem" ~ '-----BEGIN (?!CERTIFICATE-----)';
