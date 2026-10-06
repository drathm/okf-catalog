---
type: Term
title: Alpha
description: The alpha term, the fully described page every happy-path test starts from.
tags: [alpha, glossary]
resource: https://example.test/glossary/alpha
status: stable
generated: { by: human:editor, at: 2000-02-01T10:00:00Z }
verified:
  - { by: process:nightly, at: 2000-02-15T02:00:00Z }
  - { by: human:reviewer, at: 2000-03-01T09:00:00Z }
stale_after: 2999-12-31
sources:
  - id: alpha-handbook
    resource: https://example.test/handbook/alpha
    title: The alpha handbook
    author: team:docs
    usage_count: 42
    last_modified: 2000-01-20
usage_window: { from: 2000-01-01, to: 2000-01-31 }
---

# Alpha

Alpha is the first term.[^alpha-handbook] It links to [beta](/terms/beta.md) by a bundle-absolute path, to [gamma](./gamma.md) by a relative path, and to a page that does not exist: [missing](/terms/missing.md).

The second sentence is here so the first sentence can be told apart.

[^alpha-handbook]: The alpha handbook
