"""Compatibility module for the pre-1.2 LipDub pipeline name.

Persisted Studio requests keep the public ``lipdub`` mode ID while execution uses
the upstream 1.2 ``DubItPipeline`` implementation.
"""

from ltx_pipelines.dubit import DubItPipeline, main

LipDubPipeline = DubItPipeline

__all__ = ["DubItPipeline", "LipDubPipeline"]


if __name__ == "__main__":
    main()
