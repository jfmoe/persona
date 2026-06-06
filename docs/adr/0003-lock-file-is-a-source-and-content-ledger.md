# Lock file is a source and content ledger

`~/.persona/.lock.json` records where imported persona masks came from, the requested source ref, the source-local mask path, and a content hash. It exists to support future outdated and update checks; it does not create a default managed/unmanaged distinction in `persona list`, because manually placed masks remain first-class local masks even though they have no upgrade metadata.
