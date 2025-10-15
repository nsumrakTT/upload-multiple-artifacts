## Upload Multiple Artifacts (GitHub Action)

Uploads multiple artifacts based on a JSON config file using the GitHub Actions artifact toolkit.

- **Artifact toolkit**: [GitHub Actions Toolkit – artifact package](https://github.com/actions/toolkit/tree/main/packages/artifact)

### Inputs

- **config** (required): Path to a JSON file containing an array of objects with `name` and `path` fields.
- **continue-on-error** (optional, default `false`): If `true`, artifacts that resolve to no files are skipped with a warning instead of failing the action.

### JSON Schema (informal)

The JSON file must be an array. Each item must have:

```json
[
  {
    "name": "artifact-name",
    "path": "path/to/file-or-directory"
  },
  {
    "name": "another-artifact",
    "path": ["dir1", "dir2/subdir", "file.txt"]
  }
]
```

- `path` supports file or directory paths. Globs are not supported.

### Example Config

Save as `artifacts.json` in your repository:

```json
[
  { "name": "logs", "path": "logs" },
  { "name": "reports", "path": ["coverage", "reports/junit.xml"] }
]
```

### Example Workflow

```yaml
name: Upload Artifacts
on: [push]

jobs:
  upload:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build
        run: |
          mkdir -p logs coverage reports
          echo "hello" > logs/app.log
          echo "<tests/>" > reports/junit.xml
      - name: Upload Multiple Artifacts
        uses: ./. 
        with:
          config: artifacts.json
          continue-on-error: 'false'
```

### Development

Build the action with:

```bash
npm install
npm run build
```

This uses `@vercel/ncc` to bundle to `dist/index.js`.

### Notes

- This action preserves relative paths by computing a common root directory for all files of an artifact.
- Directories are uploaded recursively.
- For advanced features (like globs or retention days), see the underlying toolkit API: [artifact package](https://github.com/actions/toolkit/tree/main/packages/artifact).


