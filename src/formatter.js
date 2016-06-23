// [VexFlow](http://vexflow.com) - Copyright (c) Mohit Muthanna 2010.
//
// ## Description
//
// This file implements the formatting and layout algorithms that are used
// to position notes in a voice. The algorithm can align multiple voices both
// within a stave, and across multiple staves.
//
// To do this, the formatter breaks up voices into a grid of rational-valued
// `ticks`, to which each note is assigned. Then, minimum widths are assigned
// to each tick based on the widths of the notes and modifiers in that tick. This
// establishes the smallest amount of space required for each tick.
//
// Finally, the formatter distributes the left over space proportionally to
// all the ticks, setting the `x` values of the notes in each tick.
//
// See `tests/formatter_tests.js` for usage examples. The helper functions included
// here (`FormatAndDraw`, `FormatAndDrawTab`) also serve as useful usage examples.

import { Vex } from './vex';
import { Flow } from './tables';
import { Fraction } from './fraction';
import { Voice } from './voice';
import { Beam } from './beam';
import { StaveConnector } from './staveconnector';
import { StaveNote } from './stavenote';
import { ModifierContext } from './modifiercontext';
import { TickContext } from './tickcontext';

// To enable logging for this class. Set `Vex.Flow.Formatter.DEBUG` to `true`.
function L() { if (Formatter.DEBUG) Vex.L("Vex.Flow.Formatter", arguments); }

// Helper function to locate the next non-rest note(s).
function lookAhead(notes, rest_line, i, compare) {
  // If no valid next note group, next_rest_line is same as current.
  let next_rest_line = rest_line;

  // Get the rest line for next valid non-rest note group.
  i++;
  while (i < notes.length) {
    if (!notes[i].isRest() && !notes[i].shouldIgnoreTicks()) {
      next_rest_line = notes[i].getLineForRest();
      break;
    }
    i++;
  }

  // Locate the mid point between two lines.
  if (compare && rest_line != next_rest_line) {
    const top = Vex.Max(rest_line, next_rest_line);
    const bot = Vex.Min(rest_line, next_rest_line);
    next_rest_line = Vex.MidLine(top, bot);
  }
  return next_rest_line;
}

// Take an array of `voices` and place aligned tickables in the same context. Returns
// a mapping from `tick` to `context_type`, a list of `tick`s, and the resolution
// multiplier.
//
// Params:
// * `voices`: Array of `Voice` instances.
// * `context_type`: A context class (e.g., `ModifierContext`, `TickContext`)
// * `add_fn`: Function to add tickable to context.
function createContexts(voices, context_type, add_fn) {
  if (!voices || !voices.length) throw new Vex.RERR("BadArgument",
      "No voices to format");

  // Initialize tick maps.
  const totalTicks = voices[0].getTotalTicks();
  const tickToContextMap = {};
  const tickList = [];
  const contexts = [];

  let resolutionMultiplier = 1;

  // Find out highest common multiple of resolution multipliers.
  // The purpose of this is to find out a common denominator
  // for all fractional tick values in all tickables of all voices,
  // so that the values can be expanded and the numerator used
  // as an integer tick value.
  let i; // shared iterator
  let voice;
  for (i = 0; i < voices.length; ++i) {
    voice = voices[i];
    if (!(voice.getTotalTicks().equals(totalTicks))) {
      throw new Vex.RERR("TickMismatch",
          "Voices should have same total note duration in ticks.");
    }

    if (voice.getMode() == Voice.Mode.STRICT && !voice.isComplete())
      throw new Vex.RERR("IncompleteVoice",
        "Voice does not have enough notes.");

    const lcm = Fraction.LCM(resolutionMultiplier,
        voice.getResolutionMultiplier());
    if (resolutionMultiplier < lcm) {
      resolutionMultiplier = lcm;
    }
  }

  // For each voice, extract notes and create a context for every
  // new tick that hasn't been seen before.
  for (i = 0; i < voices.length; ++i) {
    voice = voices[i];

    const tickables = voice.getTickables();

    // Use resolution multiplier as denominator to expand ticks
    // to suitable integer values, so that no additional expansion
    // of fractional tick values is needed.
    const ticksUsed = new Fraction(0, resolutionMultiplier);

    for (let j = 0; j < tickables.length; ++j) {
      const tickable = tickables[j];
      const integerTicks = ticksUsed.numerator;

      // If we have no tick context for this tick, create one.
      if (!tickToContextMap[integerTicks]) {
        const newContext = new context_type();
        contexts.push(newContext);
        tickToContextMap[integerTicks] = newContext;
      }

      // Add this tickable to the TickContext.
      add_fn(tickable, tickToContextMap[integerTicks]);

      // Maintain a sorted list of tick contexts.
      tickList.push(integerTicks);
      ticksUsed.add(tickable.getTicks());
    }
  }

  return {
    map: tickToContextMap,
    array: contexts,
    list: Vex.SortAndUnique(tickList, (a, b) => a - b,
        (a, b) => a === b ),
    resolutionMultiplier
  };
}

export class Formatter {

  // Helper function to format and draw a single voice. Returns a bounding
  // box for the notation.
  //
  // Parameters:
  // * `ctx` - The rendering context
  // * `stave` - The stave to which to draw (`Stave` or `TabStave`)
  // * `notes` - Array of `Note` instances (`StaveNote`, `TextNote`, `TabNote`, etc.)
  // * `params` - One of below:
  //    * Setting `autobeam` only `(context, stave, notes, true)` or `(ctx, stave, notes, {autobeam: true})`
  //    * Setting `align_rests` a struct is needed `(context, stave, notes, {align_rests: true})`
  //    * Setting both a struct is needed `(context, stave, notes, {autobeam: true, align_rests: true})`
  //
  // `autobeam` automatically generates beams for the notes.
  // `align_rests` aligns rests with nearby notes.
  static FormatAndDraw(ctx, stave, notes, params) {
    const opts = {
      auto_beam: false,
      align_rests: false
    };

    if (typeof params == "object") {
      Vex.Merge(opts, params);
    } else if (typeof params == "boolean") {
      opts.auto_beam = params;
    }

    // Start by creating a voice and adding all the notes to it.
    const voice = new Voice(Flow.TIME4_4).
      setMode(Voice.Mode.SOFT);
    voice.addTickables(notes);

    // Then create beams, if requested.
    let beams = null;
    if (opts.auto_beam) {
      beams = Beam.applyAndGetBeams(voice);
    }

    // Instantiate a `Formatter` and format the notes.
    new Formatter().
      joinVoices([voice], {align_rests: opts.align_rests}).
      formatToStave([voice], stave, {align_rests: opts.align_rests});

    // Render the voice and beams to the stave.
    voice.setStave(stave);
    voice.draw(ctx, stave);
    if (beams != null) {
      for (let i=0; i<beams.length; ++i) {
        beams[i].setContext(ctx).draw();
      }
    }

    // Return the bounding box of the voice.
    return voice.getBoundingBox();
  }

  // Helper function to format and draw aligned tab and stave notes in two
  // separate staves.
  //
  // Parameters:
  // * `ctx` - The rendering context
  // * `tabstave` - A `TabStave` instance on which to render `TabNote`s.
  // * `stave` - A `Stave` instance on which to render `Note`s.
  // * `notes` - Array of `Note` instances for the stave (`StaveNote`, `BarNote`, etc.)
  // * `tabnotes` - Array of `Note` instances for the tab stave (`TabNote`, `BarNote`, etc.)
  // * `autobeam` - Automatically generate beams.
  // * `params` - A configuration object:
  //    * `autobeam` automatically generates beams for the notes.
  //    * `align_rests` aligns rests with nearby notes.
  static FormatAndDrawTab(ctx, tabstave, stave, tabnotes, notes, autobeam, params) {
    const opts = {
      auto_beam: autobeam,
      align_rests: false
    };

    if (typeof params == "object") {
      Vex.Merge(opts, params);
    } else if (typeof params == "boolean") {
      opts.auto_beam = params;
    }

    // Create a `4/4` voice for `notes`.
    const notevoice = new Voice(Flow.TIME4_4).
      setMode(Voice.Mode.SOFT);
    notevoice.addTickables(notes);

    // Create a `4/4` voice for `tabnotes`.
    const tabvoice = new Voice(Flow.TIME4_4).
      setMode(Voice.Mode.SOFT);
    tabvoice.addTickables(tabnotes);

    // Generate beams if requested.
    let beams = null;
    if (opts.auto_beam) {
      beams = Beam.applyAndGetBeams(notevoice);
    }


    // Instantiate a `Formatter` and align tab and stave notes.
    new Formatter().
      joinVoices([notevoice], {align_rests: opts.align_rests}).
      joinVoices([tabvoice]).
      formatToStave([notevoice,tabvoice], stave, {align_rests: opts.align_rests});

    // Render voices and beams to staves.
    notevoice.draw(ctx, stave);
    tabvoice.draw(ctx, tabstave);
    if (beams != null) {
      for (let i=0; i<beams.length; ++i) {
        beams[i].setContext(ctx).draw();
      }
    }

    // Draw a connector between tab and note staves.
    (new StaveConnector(stave, tabstave)).setContext(ctx).draw();
  }

  // Auto position rests based on previous/next note positions.
  //
  // Params:
  // * `notes`: An array of notes.
  // * `align_all_notes`: If set to false, only aligns non-beamed notes.
  // * `align_tuplets`: If set to false, ignores tuplets.
  static AlignRestsToNotes(notes, align_all_notes, align_tuplets) {
    for (let i = 0; i < notes.length; ++i) {
      if (notes[i] instanceof StaveNote && notes[i].isRest()) {
        const note = notes[i];

        if (note.tuplet && !align_tuplets) continue;

        // If activated rests not on default can be rendered as specified.
        const position = note.getGlyph().position.toUpperCase();
        if (position != "R/4" && position != "B/4") {
          continue;
        }

        if (align_all_notes || note.beam != null) {
          // Align rests with previous/next notes.
          const props = note.getKeyProps()[0];
          if (i === 0) {
            props.line = lookAhead(notes, props.line, i, false);
            note.setKeyLine(0, props.line);
          } else if (i > 0 && i < notes.length) {
            // If previous note is a rest, use its line number.
            let rest_line;
            if (notes[i-1].isRest()) {
              rest_line = notes[i-1].getKeyProps()[0].line;
              props.line = rest_line;
            } else {
              rest_line = notes[i-1].getLineForRest();
              // Get the rest line for next valid non-rest note group.
              props.line = lookAhead(notes, rest_line, i, true);
            }
            note.setKeyLine(0, props.line);
          }
        }
      }
    }

    return this;
  }

  constructor() {
    // Minimum width required to render all the notes in the voices.
    this.minTotalWidth = 0;

    // This is set to `true` after `minTotalWidth` is calculated.
    this.hasMinTotalWidth = false;

    // The suggested amount of space for each tick.
    this.pixelsPerTick = 0;

    // Total number of ticks in the voice.
    this.totalTicks = new Fraction(0, 1);

    // Arrays of tick and modifier contexts.
    this.tContexts = null;
    this.mContexts = null;
  }

  // Find all the rests in each of the `voices` and align them
  // to neighboring notes. If `align_all_notes` is `false`, then only
  // align non-beamed notes.
  alignRests(voices, align_all_notes) {
    if (!voices || !voices.length) throw new Vex.RERR("BadArgument",
        "No voices to format rests");
    for (let i = 0; i < voices.length; i++) {
      new Formatter.AlignRestsToNotes(voices[i].tickables, align_all_notes);
    }
  }

  // Calculate the minimum width required to align and format `voices`.
  preCalculateMinTotalWidth(voices) {
    // Cache results.
    if (this.hasMinTotalWidth) return;

    // Create tick contexts if not already created.
    if (!this.tContexts) {
      if (!voices) {
        throw new Vex.RERR("BadArgument",
                           "'voices' required to run preCalculateMinTotalWidth");
      }
      this.createTickContexts(voices);
    }

    const contexts = this.tContexts;
    const contextList = contexts.list;
    const contextMap = contexts.map;

    this.minTotalWidth = 0;

    // Go through each tick context and calculate total width.
    for (let i = 0; i < contextList.length; ++i) {
      const context = contextMap[contextList[i]];

      // `preFormat` gets them to descend down to their tickables and modifier
      // contexts, and calculate their widths.
      context.preFormat();
      this.minTotalWidth += context.getWidth();
    }

    this.hasMinTotalWidth = true;

    return this.minTotalWidth;
  }

  // Get minimum width required to render all voices. Either `format` or
  // `preCalculateMinTotalWidth` must be called before this method.
  getMinTotalWidth() {
    if (!this.hasMinTotalWidth) {
      throw new Vex.RERR("NoMinTotalWidth",
          "Need to call 'preCalculateMinTotalWidth' or 'preFormat' before" +
          " calling 'getMinTotalWidth'");
    }

    return this.minTotalWidth;
  }

  // Create `ModifierContext`s for each tick in `voices`.
  createModifierContexts(voices) {
    const contexts = createContexts(voices,
        ModifierContext,
        (tickable, context) => {
          tickable.addToModifierContext(context);
        });
    this.mContexts = contexts;
    return contexts;
  }

  // Create `TickContext`s for each tick in `voices`. Also calculate the
  // total number of ticks in voices.
  createTickContexts(voices) {
    const contexts = createContexts(voices,
        TickContext,
        (tickable, context) => { context.addTickable(tickable); });

    contexts.array.forEach(context => {
      context.tContexts = contexts.array;
    });

    this.totalTicks = voices[0].getTicksUsed().clone();
    this.tContexts = contexts;
    return contexts;
  }

  // This is the core formatter logic. Format voices and justify them
  // to `justifyWidth` pixels. `rendering_context` is required to justify elements
  // that can't retreive widths without a canvas. This method sets the `x` positions
  // of all the tickables/notes in the formatter.
  preFormat(justifyWidth, rendering_context, voices, stave) {
    // Initialize context maps.
    const contexts = this.tContexts;
    const contextList = contexts.list;
    const contextMap = contexts.map;

    // If voices and a stave were provided, set the Stave for each voice
    // and preFormat to apply Y values to the notes;
    if (voices && stave) {
      voices.forEach(voice => {
        voice.setStave(stave);
        voice.preFormat();
      });
    }

    // Figure out how many pixels to allocate per tick.
    if (!justifyWidth) {
      justifyWidth = 0;
      this.pixelsPerTick = 0;
    } else {
      this.pixelsPerTick = justifyWidth / (this.totalTicks.value() * contexts.resolutionMultiplier);
    }

    // Now distribute the ticks to each tick context, and assign them their
    // own X positions.
    let x = 0;
    const center_x = justifyWidth / 2;
    let white_space = 0; // White space to right of previous note
    let tick_space = 0;  // Pixels from prev note x-pos to curent note x-pos
    let prev_tick = 0;
    let prev_width = 0;
    let lastMetrics = null;
    const initial_justify_width = justifyWidth;
    this.minTotalWidth = 0;

    let i, tick, context;

    // Pass 1: Give each note maximum width requested by context.
    for (i = 0; i < contextList.length; ++i) {
      tick = contextList[i];
      context = contextMap[tick];
      if (rendering_context) context.setContext(rendering_context);

      // Make sure that all tickables in this context have calculated their
      // space requirements.
      context.preFormat();

      const thisMetrics = context.getMetrics();
      const width = context.getWidth();
      this.minTotalWidth += width;
      let min_x = 0;
      const pixels_used = width;

      // Calculate space between last note and next note.
      tick_space = Math.min((tick - prev_tick) * this.pixelsPerTick, pixels_used);

      // Shift next note up `tick_space` pixels.
      let set_x = x + tick_space;

      // Calculate the minimum next note position to allow for right modifiers.
      if (lastMetrics != null) {
        min_x = x + prev_width - lastMetrics.extraLeftPx;
      }

      // Determine the space required for the previous tick.
      // The `shouldIgnoreTicks` bool is true for elements in the stave
      // that don't consume ticks (bar lines, key and time signatures, etc.)
      set_x = context.shouldIgnoreTicks() ?
          (min_x + context.getWidth()) : Math.max(set_x, min_x);

      if (context.shouldIgnoreTicks() && justifyWidth) {
          // This note stole room... recalculate with new justification width.
          justifyWidth -= context.getWidth();
          this.pixelsPerTick = justifyWidth /
            (this.totalTicks.value() * contexts.resolutionMultiplier);
      }

      // Determine pixels needed for left modifiers.
      let left_px = thisMetrics.extraLeftPx;

      // Determine white space to right of previous tick (from right modifiers.)
      if (lastMetrics != null) {
        white_space = (set_x - x) - (prev_width -
                                     lastMetrics.extraLeftPx);
      }

      // Deduct pixels from white space quota.
      if (i > 0) {
        if (white_space > 0) {
          if (white_space >= left_px) {
            // Have enough white space for left modifiers - no offset needed.
            left_px = 0;
          } else {
            // Decrease left modifier offset by amount of white space.
            left_px -= white_space;
          }
        }
      }

      // Adjust the tick x position with the left modifier offset.
      set_x += left_px;

      // Set the `x` value for the context, which sets the `x` value for all
      // tickables in this context.
      context.setX(set_x);
      context.setPixelsUsed(pixels_used);  // ??? Remove this if nothing breaks

      lastMetrics = thisMetrics;
      prev_width = width;
      prev_tick = tick;
      x = set_x;
    }

    this.hasMinTotalWidth = true;
    if (justifyWidth > 0) {
      // Pass 2: Take leftover width, and distribute it to proportionately to
      // all notes.
      const remaining_x = initial_justify_width - (x + prev_width);
      const leftover_pixels_per_tick = remaining_x / (this.totalTicks.value() * contexts.resolutionMultiplier);
      let accumulated_space = 0;
      prev_tick = 0;

      for (i = 0; i < contextList.length; ++i) {
        tick = contextList[i];
        context = contextMap[tick];
        tick_space = (tick - prev_tick) * leftover_pixels_per_tick;
        accumulated_space = accumulated_space + tick_space;
        context.setX(context.getX() + accumulated_space);
        prev_tick = tick;

        // Move center aligned tickables to middle
        const centeredTickables = context.getCenterAlignedTickables();

        /*jshint -W083 */
        centeredTickables.forEach(tickable => {
          tickable.center_x_shift = center_x - context.getX();
        });
      }
    }
  }

  // This is the top-level call for all formatting logic completed
  // after `x` *and* `y` values have been computed for the notes
  // in the voices.
  postFormat() {
    // Postformat modifier contexts
    this.mContexts.list.forEach(function(mContext) {
      this.mContexts.map[mContext].postFormat();
    }, this);

    // Postformat tick contexts
    this.tContexts.list.forEach(function(tContext) {
      this.tContexts.map[tContext].postFormat();
    }, this);

    return this;
  }

  // Take all `voices` and create `ModifierContext`s out of them. This tells
  // the formatters that the voices belong on a single stave.
  joinVoices(voices) {
    this.createModifierContexts(voices);
    this.hasMinTotalWidth = false;
    return this;
  }

  // Align rests in voices, justify the contexts, and position the notes
  // so voices are aligned and ready to render onto the stave. This method
  // mutates the `x` positions of all tickables in `voices`.
  //
  // Voices are full justified to fit in `justifyWidth` pixels.
  //
  // Set `options.context` to the rendering context. Set `options.align_rests`
  // to true to enable rest alignment.
  format(voices, justifyWidth, options) {
    const opts = {
      align_rests: false,
      context: null,
      stave: null
    };

    Vex.Merge(opts, options);
    this.alignRests(voices, opts.align_rests);
    this.createTickContexts(voices);
    this.preFormat(justifyWidth, opts.context, voices, opts.stave);

    // Only postFormat if a stave was supplied for y value formatting
    if (opts.stave) this.postFormat();

    return this;
  }

  // This method is just like `format` except that the `justifyWidth` is inferred
  // from the `stave`.
  formatToStave(voices, stave, options) {
    const justifyWidth = stave.getNoteEndX() - stave.getNoteStartX() - 10;
    L("Formatting voices to width: ", justifyWidth);
    const opts = {context: stave.getContext()};
    Vex.Merge(opts, options);
    return this.format(voices, justifyWidth, opts);
  }
}
