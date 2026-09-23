"""Operational/QA scripts for python-ai. Not imported by the app itself.

Marked as a regular package (rather than left as a namespace package) so
`from scripts.qa_budget import ...` resolves deterministically under pytest,
where tests/scripts/ (an unrelated regular package for eval_retrieval.py)
would otherwise be found first by Python's import system regardless of
sys.path order — a namespace-package portion never outranks a regular
package on any other sys.path entry, so this file exists only to make
backend/python-ai/scripts one too.
"""
