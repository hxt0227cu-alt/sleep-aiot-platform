import pytest

from app.semantic_evaluation import build_semantic_cases, evaluate_case


@pytest.mark.asyncio
@pytest.mark.parametrize("case", build_semantic_cases(), ids=lambda case: case["id"])
async def test_semantic_baseline(case):
    result = await evaluate_case(case)
    assert result["passed"], result["failures"]
