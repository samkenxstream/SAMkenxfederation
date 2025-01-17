import { assert } from "@apollo/federation-internals";

type Choices<T> = (T | undefined)[];

type Partial<P, T> = {
  partial: P,
  remaining: Choices<T>[],
  isRoot: boolean,
  index?: number,
}

/**
 * Given some initial partial plan and a list of options for the remaining parts that need to be added to that plan to make it complete,
 * this method "efficiently" generates (or at least evaluate) all the possible complete plans and the returns the "best" one (the one
 * with the lowest cost).
 *
 * Note that this method abstracts the actualy types of both plans and additional elements to add to the plan, and this both for clarity
 * and to make testing of this method easier. But type parameter `P` should be though of as abstracting a query plan (in practice, it
 * is instanciated to a pair of a [`DependencyGraph`, corresponding `PathTree`]), whith `E` should be though of as an additional element
 * to add to the plan to make it complete (instanciated in practice by a `PathTree` for ... reasons ... but one that really correspond to
 * a single `GraphPath`).
 *
 * As said above, this method takes 2 arguments:
 * - `initial` is a partial plan, and corresponds to all the parts of the query being planned for which there no choices (and
 *   theoretically can be empty, though very very rarely is in practice).
 * - `toAdd` is the list of additional elements to add to `initial` ot make a full plan of the query being planned. Each element of
 *   `toAdd` corresponds to one of the query "leaf" and is itself a list of all the possible options for that "leaf".
 *
 * In other words, a comple plan is obtained by picking one choice in each of the element of `toAdd` (so picking `toAdd.length` element)
 * and adding them all to `initial`. The question being, which particular choice for each element of `toAdd` yield the best plan.
 *
 * Of course, the total number of possible plans is the cartesian product of `toAdd`, which can get large, and so this method is trying
 * to trim some of the options. For that, the general idea is that we first generate one of the plan, compute its cost, and then as
 * we build other options, we can check as we pick elements of `toAdd` the cost of what we get, and if we ever get a higher cost than
 * the one fo the complete plan we already have, then there is no point in checking the remaining elements, and we can thus cut all
 * the options for the remaining elements. In other words, if a partial plan is ever already more costly than another full plan we
 * have computed, then adding more will never get us a better plan.
 *
 * Of course, this method is not guaranteed to save work, and in the worst case, we'll still generate all plans. But when a "good" 
 * plan is generated early, it can save a lot of computing work.
 *
 * And the 2nd "trick" of this method is that it starts by generating the plans that correspond to picking choices in `toAdd` at
 * the same indexes, and this because this often actually generate good plans. The reason is that the order of choices for each
 * element of `toAdd` is not necessarily random, because the algorithm generating paths is not random either. In other words, elements
 * at similar indexes have some good change to correspond to similar choices, and so will tend to correspond to good plans.
 *
 * @param initial - the initial partial plan to use. 
 * @param toAdd - a list of the remaining "elements" to add to `initial`. Each element of `toAdd` correspond to multiple choice we can 
 *   use to plan that particular element.
 * @param addFct - how to obtain a new plan by taking some plan and adding a new element to it.
 * @param costFct - how to compute the cost of a plan.
 * @param onPlan - an optional method called on every _complete_ plan generated by this method, with both the cost of that plan and
 *   the best cost we have generated thus far (if that's not the first plan generated). This mostly exists to allow some debugging.
 */
export function generateAllPlansAndFindBest<P, E>({
  initial,
  toAdd,
  addFct,
  costFct,
  onPlan = () => {},
}: {
  initial: P,
  toAdd: E[][],
  addFct: (p: P, e: E) => P,
  costFct: (p: P) => number,
  onPlan?: (p: P, cost: number, previousCost: number | undefined) => void,
}): {
  best: P,
  cost: number,
}{
  const stack: Partial<P, E>[] = [{
    partial: initial,
    remaining: toAdd,
    isRoot: true,
    index: 0,
  }];

  let min: { best: P, cost: number } | undefined = undefined;

  while (stack.length > 0) {
    const { partial, remaining, isRoot, index } = stack.pop()!;
    const nextChoices = remaining[0];
    const otherChoices = remaining.slice(1);

    const pickedIndex = pickNext(index, nextChoices);
    const { extracted, updatedChoices, isLast } = extract(pickedIndex, nextChoices);

    if (!isLast) {
      // First, re-insert what correspond to all the choices that dot _not_ pick `extracted`.
      insertInStack({
        partial,
        remaining: [updatedChoices].concat(otherChoices),
        isRoot,
        index: isRoot && index !== undefined && index < nextChoices.length - 1 ? index + 1 : undefined,
      }, stack);
    }

    const newPartial = addFct(partial, extracted);
    if (otherChoices.length === 0) {
      // We have a complete plan. Compute the cost, check if it is best and based on that,
      // provide it to `onGenerated` or discard it.
      const cost = costFct(newPartial);
      const isNewMin = min === undefined || cost < min.cost;
      onPlan(newPartial, cost, min?.cost);
      if (isNewMin) {
        min = {
          best: newPartial,
          cost
        };
      }
      continue;
    }

    if (min !== undefined) {
      // We're not done, but we've already generated a plan with a score, so we check if
      // what we have so far is already more costly, and if it is, we skip this branch
      // entirely.
      const cost = costFct(newPartial);
      if (cost >= min.cost) {
        continue;
      }
    }

    insertInStack({
      partial: newPartial,
      remaining: otherChoices,
      isRoot: false,
      index
    }, stack);
  }

  assert(min, 'A plan should have been found');
  return min;
}

function insertInStack<P, E>(elt: Partial<P, E>, stack: Partial<P, E>[]) {
  // We push elements with a fixed index at the end so they are handled first.
  if (elt.index !== undefined) {
    stack.push(elt);
  } else {
    stack.unshift(elt);
  }
}

function pickNext<E>(index: number | undefined, remaining: Choices<E>): number {
  if (index === undefined || index >= remaining.length) {
    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i] !== undefined) {
        return i;
      }
    }
    assert(false, 'Passed a "remaining" with all undefined');
  } else {
    assert(remaining[index] !== undefined, () => `Invalid index ${index}`);
    return index;
  }
}

function extract<E>(index: number, choices: Choices<E>): { extracted: E, isLast: boolean, updatedChoices: Choices<E>} {
  const extracted = choices[index];
  assert(extracted !== undefined, () => `Index ${index} of ${choices} is undefined`)
  const updatedChoices = new Array<E | undefined>(choices.length);
  let isLast = true;
  for (let i = 0; i < choices.length; i++) {
    if (i !== index) {
      isLast &&= choices[i] === undefined;
      updatedChoices[i] = choices[i];
    }
  }
  return {
    extracted,
    isLast,
    updatedChoices,
  };
} 

