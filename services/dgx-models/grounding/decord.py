"""Image-only compatibility stub for LocateAnything on aarch64.

The model's processor imports decord for optional video handling. This service
supports images only, so importing the unavailable aarch64 decord wheel is
intentionally replaced with a clear runtime error.
"""


class VideoReader:
    def __init__(self, *args, **kwargs):
        raise RuntimeError("Video input is not supported by this LocateAnything service")


def cpu(index=0):
    return index
