---
permissions:
  allow:
    - shell: "npm run test*"
    - fs.write: "src/**"
mcp:
  github:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_TOKEN: "${env:GITHUB_TOKEN}"
---
