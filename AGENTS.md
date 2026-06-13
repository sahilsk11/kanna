# Agent Instructions

## GitHub Pull Requests

- This checkout uses `origin` as Sahil's fork: `sahilsk11/kanna`.
- `upstream` is the original repository: `jakemor/kanna`.
- When opening pull requests from this repository, create them against `sahilsk11/kanna`, not `jakemor/kanna`.
- Prefer an explicit command so GitHub does not infer the upstream repository:

```sh
gh pr create --repo sahilsk11/kanna --base main --head <branch>
```

