/** Same-version corrections with stable stage IDs and explicit review checks.
 * Older browser saves predate local content pins; unknown nonempty pins are not
 * accepted. These pins deliberately stop matching if a later definition changes. */
type Correction = {
  previousDefinitionSha256: string;
  targetDefinitionSha256: string;
  recheckFailures: string[];
  additionalSources?: { definitionSha256: string; recheckFailures: string[] }[];
  stageReviewIssue?: string;
};
export const failureDefinitionCorrections: Record<"marker_d2" | "square_d2" | "routing_d1", Correction> = {
  "marker_d2": {
    "previousDefinitionSha256": "1c42d8d2c2a853e7a4f5ad9d5f820815469c15826caa89199ae5f43a04a04249",
    "targetDefinitionSha256": "4dfbd4a1cf35e8938cf1c8a5c01bedb57739c3e3834785758e448b6a5e4f86d4",
    "recheckFailures": [
      "false_insertion",
      "incomplete_insertion"
    ]
  },
  "square_d2": {
    "previousDefinitionSha256": "bf4c76d985ab1a17ed6bfadd49e9d5faac278e6e3ba99abff21c932e18705073",
    "targetDefinitionSha256": "274367f07f49123496c66a0fe7c57972f8e55f32ef6a75c5c89c2179b7ffa49a",
    "recheckFailures": [
      "false_insertion",
      "incomplete_insertion"
    ]
  },
  "routing_d1": {
    "previousDefinitionSha256": "32d3e8f5cd163f03cd93c3a6a099421485edcef6964185c53ef50cf1629b2449",
    "targetDefinitionSha256": "cf728a36c41ed9e869d46262cc61c39277ddb3d6b315ebe1338792be847c2af2",
    "stageReviewIssue": "Check S3/S8 and S4/S9 timing: spanning the clip now needs no insertion-direction alignment; engagement is correctly directed entrance contact, even before entry. Saved marks and outcome are preserved, not re-certified.",
    "recheckFailures": [
      "first_clip_seating_incomplete",
      "second_clip_seating_incomplete",
      "grasp_not_established",
      "grasp_lost"
    ],
    "additionalSources": [{
      "definitionSha256": "e545f73ed433024839bf6ed2f51cb9db0f997a1577dbc586c029d820bba2ae12",
      "recheckFailures": ["grasp_not_established", "grasp_lost"]
    }, {
      "definitionSha256": "ddf423c02e069c5fd959b4a9e98b874bb25be03f4e12d36905b800093a8e9bb0",
      "recheckFailures": []
    }]
  }
};
