# Markdown Documentation Utilities

This project provides series of tools to handle Markdown (`.md`)
documents based on [ProFUSION](https://profusion.mobi/) needs. You may
use it and modify to fit your own needs, however bugfixes and features
are welcome.

## Utilities

### md2html.js

`md2html.js` uses [marked](http://npmjs.com/package/marked) to
generate the HTML, however will allow a front and back page HTML to be
processed using [mustache](http://npmjs.com/package/mustache) and then
included around the actual contents coming from `.md`. It also enables
including series of CSS and JavaScript files, which are concatenated
and included in the document. Last but not least, the Table of
Contents (ToC) may be generated.

# License

MIT
