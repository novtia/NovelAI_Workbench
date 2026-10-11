from contexts.generation.nai_client import NaiError, build_payload, uses_medium


def test_high_keeps_requested_sampler_steps_and_uc():
    payload, meta = build_payload(
        {
            "prompt": "1girl",
            "uc": "lowres",
            "model": "nai-diffusion-5-full",
            "effort": "high",
            "steps": 23,
            "sampler": "k_euler",
            "cfgRescale": 0.2,
            "seed": 7,
            "characters": [{"prompt": "girl", "uc": "hat", "x": 0.2, "y": 0.4}],
        }
    )
    assert payload["model"] == "nai-diffusion-5-full"
    assert payload["parameters"]["steps"] == 23
    assert payload["parameters"]["sampler"] == "k_euler"
    assert payload["parameters"]["cfg_rescale"] == 0.2
    assert payload["parameters"]["negative_prompt"] == "lowres"
    assert payload["parameters"]["v4_negative_prompt"]["caption"]["char_captions"][0]["char_caption"] == "hat"
    assert meta["effort"] == "high"


def test_medium_switches_model_and_locks_unsupported_settings():
    payload, meta = build_payload(
        {
            "prompt": "1girl, silver hair",
            "uc": "lowres, hat",
            "model": "nai-diffusion-5-full",
            "effort": "medium",
            "steps": 28,
            "sampler": "k_dpmpp_2m",
            "noiseSchedule": "exponential",
            "cfgRescale": 0.4,
            "scale": 6,
            "seed": 3,
            "characters": [{"prompt": "girl", "uc": "hat", "x": 0.5, "y": 0.5}],
        }
    )
    params = payload["parameters"]
    assert payload["model"] == "nai-diffusion-5-full-medium"
    assert params["steps"] == 14
    assert params["sampler"] == "k_euler_ancestral"
    assert params["noise_schedule"] == "karras"
    assert params["scale"] == 6
    assert "cfg_rescale" not in params
    assert params["negative_prompt"] == ""
    assert params["v4_negative_prompt"]["caption"]["base_caption"] == ""
    assert params["v4_negative_prompt"]["caption"]["char_captions"][0]["char_caption"] == ""
    assert params["prefer_brownian"] is True
    assert meta["effort"] == "medium"
    assert meta["model"] == "nai-diffusion-5-full-medium"
    assert uses_medium({"model": "nai-diffusion-5-full", "effort": "medium", "steps": 28})


def test_curated_ignores_medium_effort():
    payload, meta = build_payload({"prompt": "cat", "model": "nai-diffusion-5-curated", "effort": "medium", "seed": 1, "uc": "lowres"})
    assert payload["model"] == "nai-diffusion-5-curated"
    assert payload["parameters"]["steps"] == 28
    assert payload["parameters"]["negative_prompt"] == "lowres"
    assert "cfg_rescale" in payload["parameters"]
    assert meta["effort"] == "high"


def test_medium_model_id_is_accepted_directly():
    payload, _meta = build_payload({"prompt": "cat", "model": "nai-diffusion-5-full-medium", "steps": 30, "seed": 1, "uc": "lowres"})
    assert payload["model"] == "nai-diffusion-5-full-medium"
    assert payload["parameters"]["steps"] == 14
    assert payload["parameters"]["negative_prompt"] == ""


def test_unknown_model_is_rejected():
    try:
        build_payload({"prompt": "cat", "model": "nai-diffusion-4-full", "seed": 1})
    except NaiError as exc:
        assert exc.status == 400
    else:
        raise AssertionError("expected NaiError")
