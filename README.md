# aisearch — AI-friendly code search and reading

> 中文：[README.zh-CN.md](README.zh-CN.md) ｜ Changelog: [CHANGELOG.md](CHANGELOG.md)

`aisearch` is a code navigation tool built for AI agents (and humans), designed to replace `grep -rn`
and heavyweight LSP setups with one zero-dependency command.

**Designed around three pain points**: plain `grep` output has no structure, a full LSP is too heavy,
and agents usually fall back to the crudest tool available.

**Core ideas**: zero-install dependencies, structured JSON output, regex-based symbol extraction
(no language server needed), and a built-in stdio RPC mode with no daemon and no ports.

- Symbols (classes / functions / structs / interfaces, …) are extracted by **regex** — zero config, no language server
- Every result is **structured JSON**, so agents never parse fragile text
- Figures out **which function/class a given line belongs to** (semantic context)
- Reads **by symbol**: `read src/main.py#process_data` instead of the whole file
- **RPC mode**: no listening port, no daemon — start once, query many times

---

## Install

Cross-platform install scripts live in [`all/`](all/) (one set covering **macOS / Linux / Windows**):

```bash
# macOS / Linux
bash all/install.sh              # base; --test adds test deps, --full adds optional enhancements

# Windows
powershell -ExecutionPolicy Bypass -File all\install.ps1
all\install.cmd                  # cmd entry point (equivalent)
```

Manual install (run from the repository root; core features are zero-dependency, Python >= 3.9 only):

```bash
pip install -e .              # base install
pip install -e ".[full]"      # optional: tree-sitter enhancement (more accurate symbol ranges)
pip install -e ".[test]"      # optional: test dependencies
pytest
```

> A zero-dependency Node.js port lives in `aisearch-js/`; its CLI behaviour and JSON protocol match
> the Python implementation field by field.
>
> `all/` also contains an **optional whole-repo snapshot generator** (`python all/gen_bundle.py`
> produces `SOURCE.md` and a `tar.gz`; **artifacts are not committed**, `.gitignore` excludes them)
> for offline reading or delivering a repo without git. **For AI code reading, prefer `rpc` /
> `read <file>#<sym>` over feeding a whole-repo snapshot** — measured 4.9–7.8x fewer tokens.
>
> **CodeBuddy / SkillHub integration**: the skill form lives on this repo's **`skill` branch**
> (`git checkout skill`) and is not duplicated on `main`. SkillHub slug: `aisearch`.

---

## Three-layer division of labour (measured, read this on large repos)

This tool is not a universal retriever. Measured on a 2.4 GB repository (3,464 files; Rust + TS + Python):

| Task | Tool | Why |
|---|---|---|
| Plain text / regex location | **Your built-in Grep** (ripgrep) | Fastest single shot (~2s), honours ignore rules |
| Where is it implemented / `callers` / `impact` / `hubs` / `for` / repo notes | **[repo-context](https://github.com/ForceDream/repo-context)** | One `index` pass is seconds (3.1s / 367 files), then each query is <0.3s; these capabilities exist in neither this tool nor Grep |
| Reading a function body / line ownership / paging large files | **this tool** | `read <file>#<sym>` and `context` are O(single file) (measured 3 requests in 0.4s), with metadata first and `content` last |

**Key point**: `search` / `def` / `ref` / `symbols` **always do a full scan** (~4.5s / 3,464 files,
no index cache). A resident RPC session only saves process startup — **it does not save the scan**.
On large repos: **locate first (Grep / repo-context), then read precisely (this tool)**.

---

## CLI usage

Default output policy: **piped calls (agents) → JSON; interactive terminal → coloured text**.
Force either with `--json` / `--text`.

```bash
# 1. Text search (replaces grep -rn)
aisearch grep "def process"
aisearch grep "TODO" -t py,js -C 3
aisearch grep "error" -i --text
aisearch grep "\bfetch\b" -w -t ts

# 2. Symbol search (replaces LSP symbol search)
aisearch sym "handle_request"
aisearch sym "MyClass" -k class
aisearch sym "process" -k function --exact

# 3. Go to definition
aisearch def "MyClass"

# 4. Find references
aisearch ref "process_data"

# 5. Read smartly (replaces cat / sed)
aisearch cat src/main.py
aisearch cat src/main.py:10-50
aisearch cat src/main.py#process_data
aisearch cat src/main.py --outline

# 6. Semantic context of a line
aisearch ctx src/main.py:42

# 7. Project structure
aisearch tree
aisearch tree -d 5
```

---

## RPC mode (recommended for agent integration, no ports)

No `127.0.0.1`, no listening port: the agent starts `aisearch rpc` as a **child process** and
exchanges line-delimited JSON over stdin/stdout. The process exits with the session, so there is no
authentication surface, no port conflict, and no network exposure.

```bash
aisearch rpc                            # cwd as project root (boundary=system)
aisearch rpc --root /path/to/project    # locked root (boundary=root, only that tree is readable)
```

Protocol: **line-delimited JSON**, one request per line, one response per line, flushed immediately.

```
request  → {"id": 1, "method": "search", "params": {"pattern": "def foo", "limit": 20}}
response ← {"id": 1, "ok": true, "data": {"matches": [...], "total": 3, ...}}
error    ← {"id": 1, "ok": false, "error": "..."}
```

| method | params | purpose |
|--------|--------|---------|
| `search`  | `pattern, path?, context?, limit?, ignore_case?, whole_word?, extensions?` | text search |
| `symbols` | `name, path?, kind?, limit?, partial?` | symbol search |
| `def`     | `name, path?` | definition lookup (exact name first) |
| `ref`     | `name, path?, limit?` | reference lookup |
| `read`    | `file, path?, outline?` | smart file reading (`file:10-50` / `file#symbol`) |
| `context` | `file, line, radius?, path?` | semantic context of a line |
| `tree`    | `path?, depth?` | directory tree |
| `health`  | `{}` | version / methods / effective root and boundary |

Malformed requests (bad JSON, unknown method, invalid params) always return a structured error; the
process never crashes.

---

## Why not just grep + LSP?

| Aspect | grep | LSP | aisearch |
|--------|------|-----|----------|
| Install | preinstalled | needs a language server + config | `pip install`, one line |
| Output | plain text, agents must parse it | complex protocol | **structured JSON** |
| Symbol search | not supported | supported, complex to configure | **regex extraction, zero config** |
| Semantic context | surrounding N lines only | yes, but needs a running LSP | **identifies owning function/class** |
| Read by symbol | not supported | needs a client | **`read file.py#func`** |
| Resident / index | rescans every time | needs a resident language server | **resident RPC child process (no ports)**; no index, so every query still scans |

---

## Project structure

```
aisearch/
├── pyproject.toml
├── README.md (English) / README.zh-CN.md (Chinese) / CHANGELOG.md / LICENSE / SKILL.md
├── aisearch/                   # Python implementation (core)
│   ├── cli.py                  # CLI entry point
│   ├── config.py               # config, language detection, ignore rules, path safety
│   ├── symbols.py              # symbol extraction (regex)
│   ├── engine.py               # search engine (ripgrep / pure-Python fallback)
│   ├── reader.py               # smart file reading
│   └── rpc.py                  # stdio RPC mode (no ports)
├── aisearch-js/                # Node implementation (zero npm deps, protocol-aligned)
│   ├── bin/aisearch.mjs
│   ├── src/{config,engine,reader,rpc,symbols,util}.mjs
│   ├── tests/                  # parity smoke tests + robustness fuzzing
│   └── bench/                  # benchmark scripts and report
├── all/                        # cross-platform install scripts + snapshot generator (artifacts not committed)
├── assets/                     # demo corpus + sample RPC requests
├── references/                 # protocol.md (full protocol) / examples.md (real samples)
└── tests/                      # Python test suite (pytest)
```

---

## Design trade-offs

- **Regex instead of LSP**: covers Python / JS / TS / Go / Rust / Java / C / C++ / PHP / Ruby / Swift /
  Kotlin / Scala / Shell out of the box, with no language server. Symbol ranges are heuristic
  (indentation or brace balancing): indentation-based languages support **multi-line signatures**,
  brace-based languages support **full ranges for nested class/namespace members**.
- **ripgrep first, always run from the project root**: if `rg` exists, its JSON mode is used; the
  search subprocess `cwd` is pinned to the project root so ignore-globs and reported paths do not
  depend on the caller's working directory. Otherwise a pure-Python fallback keeps it dependency-free.
- **Stateless**: neither the CLI nor RPC caches project state — every query scans on demand, so there
  is no staleness or cache invalidation to reason about. The cost is a full scan per query.
- **Ignore rules**: `.aisearchignore` (exact directory/file names, `*.ext`, relative path prefixes
  such as `src/generated`).

## Security boundary

The tool distinguishes two runtime boundaries:

| Scenario | boundary | Behaviour |
|----------|----------|-----------|
| Local CLI (`cat` / `ctx`), default `rpc` | `system` | may read any path (the user is operating their own machine) |
| `rpc --root <dir>` | `root` | **only inside the given project root**; `../`, absolute paths and symlink escapes are rejected |

- Path checks compare real paths after `resolve()`; `../` and symlink escapes are rejected, as are paths containing NUL bytes.
- **Resource limits**: ≤ 5000 results, tree depth ≤ 16, context radius ≤ 200, single-file read ≤ 5 MB.
- Invalid input (non-integer, bad JSON, unknown method) always returns a structured error or falls back safely; the process never crashes on input.
- RPC listens on no port, so there is no network exposure.

## License

MIT
