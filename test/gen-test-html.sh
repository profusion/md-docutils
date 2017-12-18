#!/bin/bash

npm run gen-html -- \
    test/reports/test.md \
    --css test/style/profusion.css \
    --css test/style/paged.css \
    --front-page test/style/front-page.html \
    --back-page test/style/back-page.html \
    --author 'The Author' \
    --date='2017-06-30' \
    --var doc-id="PX_20170630_01" \
    --var contacts="Gustavo Barbieri<br/>Bruno Dilly" \
    --var notice="Some Notice Here" \
    --toc
