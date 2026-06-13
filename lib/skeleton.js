/** Standard human skeleton connections — [parentJoint, childJoint] */
export const SKELETON_CONNECTIONS = [
    // Spine
    ['Hip', 'Ab'], ['Ab', 'Chest'], ['Chest', 'Neck'], ['Neck', 'Head'],
    // Left arm
    ['Chest', 'LShoulder'], ['LShoulder', 'LUArm'], ['LUArm', 'LFArm'], ['LFArm', 'LHand'],
    // Right arm
    ['Chest', 'RShoulder'], ['RShoulder', 'RUArm'], ['RUArm', 'RFArm'], ['RFArm', 'RHand'],
    // Left leg
    ['Hip', 'LThigh'], ['LThigh', 'LShin'], ['LShin', 'LFoot'], ['LFoot', 'LToe'],
    // Right leg
    ['Hip', 'RThigh'], ['RThigh', 'RShin'], ['RShin', 'RFoot'], ['RFoot', 'RToe'],
];

/** Proximal→distal cascade chain routed from the dominant node.
 *  Side comes from the L/R prefix; leg nodes route to the leg chain,
 *  everything else (hands, implements, head…) to the arm chain. */
export const cascadeChain = (dominantNode = '') => {
    const side = /^L/.test(dominantNode) ? 'L' : 'R';
    const leg  = /Thigh|Shin|Foot|Toe/.test(dominantNode);
    return leg
        ? ['Hip', `${side}Thigh`, `${side}Shin`, `${side}Foot`, `${side}Toe`]
        : ['Hip', 'Ab', 'Chest', `${side}Shoulder`, `${side}UArm`, `${side}FArm`, `${side}Hand`];
};
