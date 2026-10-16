/**
 * Host seam: YAML parsing.
 *
 * Core code (skill manifest validation) must not import `parseYaml` from
 * `obsidian`. It takes a `YamlParser` instead; the plugin passes the Obsidian
 * implementation (`obsidianYamlParser` in `./obsidianHost`), a daemon can pass
 * a `yaml`-package-backed one.
 *
 * Contract: `parse` returns the parsed value and throws on malformed input,
 * exactly like Obsidian's `parseYaml`.
 */
export interface YamlParser {
  parse(text: string): unknown;
}
