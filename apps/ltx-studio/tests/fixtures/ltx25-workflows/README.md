# Pinned LTX 2.5 workflow fixtures

These files are the exact workflow JSON bytes from
`Lightricks/ComfyUI-LTXVideo` commit
`15d09abb5a187a8dcaea2fc31fe51ee96e6c9d0d`, compressed with deterministic
gzip (`gzip -n -9`) and base64-encoded so the fixtures remain patchable text.

Tests decode each fixture, verify the raw JSON SHA-256 against
`shared/ltx25Catalog.ts`, and only then perform the semantic graph audit. Do
not reformat the decoded JSON or update a fixture without reviewing the
resulting semantic diff.
