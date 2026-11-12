---
'lg-luma': minor
---

Open Luma Home early on a webOS 25/26 cold boot as well. The early start now also covers the manifest method: right after the boot snapshot resumes, it mounts the staged Luma manifest and has SAM reread it, ideally before bootd launches LG's Home, so a hard reboot goes from the boot logo straight to Luma instead of showing LG's Home for about 40 s.
