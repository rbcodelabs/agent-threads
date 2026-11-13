/**
 * Inputs for the strict (dock) markdown policy. Shared by the golden that
 * characterises the legacy renderDockMarkdown output and by the tests that
 * prove the shared renderer's strict path produces the same DOM.
 */
export const DOCK_THREADS = [{ id: 't1', title: 'Deploy curation' }, { id: 't2', title: 'Mobile polish' }];

/** Vault notes the dock host can open; every other [[note]] renders as inert text. */
export const DOCK_RESOLVABLE = new Set(['Project Plan', 'folder/Deep Note']);

export const DOCK_CASES: Record<string, string> = {
  gfm: '# Title\n\n**bold** _em_ ~~gone~~\n\n- a\n- b\n\n1. one\n2. two\n\n> quote\n\n| h1 | h2 |\n|----|----|\n| c1 | c2 |',
  threadLinks: 'See [[thread:t1|Deploy fix]], [[thread:Mobile polish]], [[thread:t1]] and [[thread:unknown|Ghost]].',
  noteLinks: 'Open [[Project Plan]], [[folder/Deep Note|Aliased]] and [[Missing Note]] and [[]] and [[a|b|c]].',
  labelMarkup: '[[thread:t1|<img src=x onerror=alert(1)> & <b>go</b>]] and [[thread:t1|*raw* _label_]]',
  images: '![remote](https://example.com/pic.png) ![local](/Users/test/pic.png) ![](data:image/png;base64,AAAA) <img src="https://evil.example/y.png" alt="raw">',
  hrefs: [
    '[js](javascript:alert(1)) [data](data:text/html,x) [vb](vbscript:x) [file](file:///etc/passwd)',
    '[proto](//evil.example/x) [back](\\\\evil.example) [rel](docs/a.md#h) [anchor](#top) [http](https://ok.example/p) [mail](mailto:a@b.co)',
  ].join('\n'),
  rawHtml: 'x <script>alert(1)</script><iframe src="https://e.example"></iframe><style>a{}</style> y <p style="background:url(https://x.example/d.png)" onclick="alert(1)">styled</p>',
  rawAnchors: '<a class="ct-thread-link" data-thread-id="t2" href="#">classed</a> <a class="internal-link" data-href="Secret" href="#">wiki</a> <a href="javascript:alert(1)" onmouseover="x()">js</a>',
  tokenInAttribute: '<a href="https://x.example" title="[[Note]]">t</a> [x](<https://y.example/[[Project Plan]]>)',
  code: 'Inline `[[Project Plan]]` and ``[[thread:t1|x]]``\n\n```md\n[[Project Plan]]\n```\n\n    [[Missing Note]]\n\nafter [[Project Plan]]',
  linkInsideLink: '[see [[thread:t1|Deploy]] here](https://example.com)',
  orderedStart: '3. three\n4. four',
};
