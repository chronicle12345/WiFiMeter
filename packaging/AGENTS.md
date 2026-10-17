# Packaging scope

- Maintain prerequisites and source build commands in [Packaging](README.md); keep active targets and release gates in the [CI and release matrix](../docs/PACKAGING-MATRIX.md).
- Preserve matching executable architectures, Node capability checks, licenses, complete runtime resources, and internal checksums. Keep package staging explicit.
- Follow [Testing](../docs/TESTING.md) for helper, native-host, and extracted-package checks. Do not equate extracted-package execution with complete installation or uninstallation.
- Changes to public asset formats or counts must update release metadata, validation, and the maintained bilingual guides together. Preserve user-data compatibility.
