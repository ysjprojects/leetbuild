"""
A learner's file run as a program, as `python file.py` would: its `if __name__ == "__main__":`
block runs (the self-test a deep-learning step ends with), beside the course's other files in
/work, with fresh modules and the real clock.
"""
import os
import runpy
import sys
import traceback

from .clock import CLOCK
from .harness import WORK, _purge_modules


def run_program(entry: str) -> int:
    """Run /work/<entry> as __main__ and return its exit status; an exception's traceback goes to stderr."""
    _purge_modules()
    if WORK not in sys.path:
        sys.path.insert(0, WORK)
    cwd, argv = os.getcwd(), sys.argv
    CLOCK.uninstall()
    try:
        os.chdir(WORK)
        sys.argv = [entry]
        # By the name it was given, as `python stable_softmax.py` reports it in a traceback.
        runpy.run_path(entry, run_name="__main__")
        return 0
    except SystemExit as exit:
        if exit.code is None or isinstance(exit.code, int):
            return exit.code or 0
        print(exit.code, file=sys.stderr)
        return 1
    except BaseException as error:
        # From the learner's first frame on: the runtime's and runpy's frames are not theirs.
        tb = error.__traceback__
        while tb is not None and _not_theirs(tb.tb_frame.f_code.co_filename, entry):
            tb = tb.tb_next
        traceback.print_exception(type(error), error, tb)
        return 1
    finally:
        CLOCK.install()
        sys.argv = argv
        os.chdir(cwd)
        sys.stdout.flush()
        sys.stderr.flush()


def _not_theirs(filename: str, entry: str) -> bool:
    return filename != entry and not filename.startswith(WORK)
