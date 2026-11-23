# Pipeline failed

```
Traceback (most recent call last):
  File "/home/runner/work/flight-window/flight-window/pipeline/build_places.py", line 605, in main
    return run(Net(), out, rep, bbox)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/home/runner/work/flight-window/flight-window/pipeline/build_places.py", line 555, in run
    image_credits(net, cands, log)
  File "/home/runner/work/flight-window/flight-window/pipeline/build_places.py", line 429, in image_credits
    lic = meta.get("LicenseShortName", {}).get("value", "")
          ^^^^^^^^
AttributeError: 'list' object has no attribute 'get'
```
