var deepcopy = require('deepcopy');
var util = require('util');

var Experiment = module.exports;

/* The organizational strategy followed below is a compound (two-layer) monad.
 * These monadic parts are then used to construct increasingly complex
 * experiment combinators, which are finally used to construct particular
 * experiment running networks.
 *
 * Such networks are driver by the Experiment.run entry point, which couples a
 * given network to a particular result sink (which defaults inspects to stdout).
 *
 * So our monad :: spec -> (emit) -> null
 * where emit   :: spec -> null
 * and spec     :: {...}
 *
 * In other words we have:
 * - functions which take
 * - some arbitrary specification object
 * - and return a continuation
 * - which will receive spec objects
 *
 * So we'll stage it in two layers; some of the parts below, especially the
 * unit functions, are provided solely for elucidation/completeness and aren't
 * used much (if at all).
 */

// TODO: the names really could use some reconsideration

// TODO: we may be able to simplify significantly by using some curry

// The outer layer is the spec -> cont functions:
Experiment.cont = function(cont) { // outer unit
  return function(spec) {return cont;};
};

Experiment.before = function(exp, f) { // outer bind
  return function(spec) {
    return f(exp(spec));
  };
};

Experiment.wrap = function(f) {
  return function(exp) {
    return function(spec) {
      return f(exp, spec);
    };
  };
};

Experiment.setup = function(f) {
  return Experiment.wrap(function(exp, spec) {
    return exp(f(spec) || spec);
  });
};

// The inner layer is the continuations themselves:

Experiment.under = function(f) {
  return function(spec) {
    return function(emit) {
      f(spec, emit);
    };
  };
};

Experiment.returnResult = function(result) { // inner unit
  return Experimnt.cont(function(emit) {emit(result);});
};

Experiment.after = function(f) { // inner bind
  return Experiment.wrap(function(exp, spec) {
    var cont = exp(deepcopy(spec));
    return function(emit) {
      cont(function(result) {emit(f(result) || result);});
    };
  });
};

Experiment.compute = function(prop, f) {
  if (arguments.length === 1) {
    f = prop;
    if (! f.name) throw new Error('specify property name, or name your function');
    prop = f.name;
  }
  var argNames = /\((.+?)\)/.exec(f.toString())[1].split(/,\s*/g);
  return Experiment.after(function(result) {
    var args = [];
    for (var i=0, n=argNames.length; i<n; i++) {
      var argName = argNames[i];
      if (result[argName] === undefined) return;
      args.push(result[argName]);
    }
    result[prop] = f.apply(this, args);
  });
};

Experiment.transform = function(prop, f) {
  return Experiment.after(function(result) {
    if (result[prop] !== undefined)
      result[prop] = f(result[prop]);
  });
};

// Now for generic parts which operate at both layers:

Experiment.run = function(exp, spec, emit) {
  if (! exp) throw new Error('no experiment given to run');
  if (typeof spec == 'function' && arguments.length == 2) {
    emit = spec;
    spec = null;
  }
  if (! spec) spec = {};
  if (spec.emit) {
    if (! emit) emit = spec.emit;
    delete spec.emit;
  }
  emit = emit || Experiment.emitInspectRecords(process.stdout);
  exp(spec)(emit);
};

Experiment.bind = function(exp, f) { // combined bind
  return function(spec) {
    return function(emit) {
      f(exp(spec), emit);
    };
  };
};

Experiment.seq = function(f, g) {
  if (arguments.length > 2)
    g = Experiment.seq.apply(null, Array.prototype.slice.call(arguments, 1));
  return f(g);
};

// And some applications

Experiment.expand = function(exp, spec, expand) {
  if (spec.parallelExpand) {
    return function(emit) {
      while (true) {
        var newspec = deepcopy(spec);
        if (! expand(newspec)) break;
        exp(newspec)(emit);
      }
    };
  } else {
    return function(emit) {
      var it = function() {
        var newspec = deepcopy(spec);
        if (! expand(newspec)) return;
        exp(newspec)(function(result) {
          emit(result);
          setImmediate(it);
        });
      };
      it();
    };
  }
};

Experiment.copy = function(src, dst) {
  return Experiment.setup(function(spec) {
    spec[dst] = deepcopy(spec[src]);
  });
};

Experiment.choose = function(prop, lo, hi) {
  if (hi === undefined) {
    hi = lo;
    lo = 0;
  }
  var width = hi - lo;
  return Experiment.setup(function(spec) {
    spec[prop] = lo + Math.random() * width;
  });
};

Experiment.timed = Experiment.wrap(function(exp, spec) {
  var cont = exp(spec);
  return function(emit) {
    var t0 = process.hrtime();
    cont(function(result) {
      var t1 = process.hrtime();
      result.runtime = (t1[0] - t0[0]) * 1e9 + (t1[1] - t0[1]);
      emit(result);
      t0 = process.hrtime();
    });
  };
});

// TODO: provide an rusage monitor similar to timed

Experiment.times = function(prop, k) {
  if (arguments.length == 1) {
    k = prop;
    prop = 'time';
  }
  return Experiment.wrap(function(exp, spec) {
    var i = 0;
    return Experiment.expand(exp, spec, function(spec) {
      if (i < k) {
        spec[prop] = i++;
        return true;
      }
    });
  });
};

Experiment.each = function(plural, singular, spec) {
  return Experiment.wrap(function(exp, spec) {
    var items;
    if (typeof(plural) === 'string') {
      items = spec[plural];
      delete spec[plural];
    } else {
      items = plural;
    }
    var i = 0;
    if (Array.isArray(items)) {
      return Experiment.expand(exp, spec, function(spec) {
        if (i < items.length) {
          spec[singular] = items[i++];
          return true;
        }
      });
    } else {
      items = Object
        .keys(items)
        .sort()
        .map(function(name) {return [name, items[name]];});
      return Experiment.expand(exp, spec, function(spec) {
        if (i < items.length) {
          var item = items[i++];
          spec[singular + '_name'] = item[0];
          spec[singular          ] = item[1];
          return true;
        }
      });
    }
  });
};

Experiment.gen = function(prop, gen, spec) {
  return Experiment.wrap(function(exp, spec) {
    var it = gen(spec, prop);
    return Experiment.expand(exp, spec, function(spec) {
      var val = it();
      if (val !== null && val !== undefined) {
        spec[prop] = val;
        return true;
      }
    });
  });
};

/* Stabilize a particular experiment metric.
 *
 * Takes an options argument; if a single string argument is given, it is
 * created to {prop: <arg>}.
 *
 * Options:
 * - prop      -- name of the property to stabilize
 * - tolerance -- maximum deviation tolerance to achieve
 *                default: 3
 * - count     -- desired sample size within tolerance range
 *                default: 10
 * - augment   -- if truthy, then each emitted result will have a <prop>_desc
 *                attribute added with structure:
 *                {
 *                  sample: [Number], // all result collected to construct the sample
 *                  med:    Number,   // the sample median
 *                  dev:    Number,   // the sample deviation (IQR / 2)
 *                  lo:     Number,   // the low cutoff:  med - tol * dev
 *                  hi:     Number    // the high cutoff: med + tol * dev
 *                }
 *
 * The deviation metric used is IQR/2, or more verbosely:
 *
 *   (sample.quantile(.75) - sample.quantile(.25)) / 2
 *
 * The goal then is to obtain count results within tol*dev of the sample median
 * (a 6-deviation spread centered within the sample space).
 */
Experiment.stabalize = function(options) {
  if (typeof options === 'string') {
    options = {prop: options};
  } else if (! options) {
    options = {};
  }

  if (! options.prop) {
    throw new Error('no property given to stabalize');
  }

  var prop      = options.prop;
  var tolerance = options.tolerance || 3;
  var count     = options.count     || 10;
  var augment   = !!options.augment;

  return Experiment.wrap(function(exp, spec) {
    return function(emit) {
      var time = 0;
      var sample = [];
      var ile = function(p) {
        var n = sample.length;
        var q = p * n;
        var i = Math.min(n-1, Math.floor(q));
        var j = Math.min(n-1, Math.ceil(q));
        return (sample[i][prop] + sample[j][prop]) / 2;
      };

      var it = function() {
        var run = deepcopy(spec);
        run.time = ++time;
        exp(run)(function(result) {
          sample.push(result);
          sample.sort(function(a, b) {
            return a[prop] - b[prop];
          });

          if (sample.length >= count) {
            var desc = {sample: sample};
            desc.med = ile(0.50);
            desc.dev = (ile(0.75) - ile(0.25)) / 2;
            desc.hi  = desc.med + tolerance * desc.dev;
            desc.lo  = Math.max(0, desc.med - tolerance * desc.dev);

            var i=null, j=null;
            sample.forEach(function(result, k) {
              if (desc.lo <= result[prop] && result[prop] <= desc.hi) {
                if (i === null) i = k;
                j = k;
              }
            });

            var got = 1 + j - i;
            if (got >= count) {
              j = j - (got - count);
              for (; i<=j; i++) {
                if (augment) {
                  sample[i][prop + '_desc'] = desc;
                }
                emit(sample[i]);
              }
              return;
            }
          }

          it();
        });
      };
      it();
    };
  });
};

// -- emission utilities (sinks)

Experiment.emitSepRecords = function(stream, sep) {
  sep = sep || ' ';
  var fields = null;
  return function(spec) {
    if (! fields ) {
      fields = Object
        .keys(spec)
        .filter(function(prop) {
          return typeof spec[prop] !== 'function';
        })
        .sort();
      stream.write(fields.join(' ') + '\n');
    }
    stream.write(
      fields
        .map(function(field) {return spec[field];})
        .join(' ') + '\n'
    );
  };
};

Experiment.emitInspectRecords = function(stream) {
  return function(result) {
    stream.write(util.inspect(result, {depth: null}));
  };
};

// -- interactive / test harness

if (require.main === module) {

  // Measures the difference between desired time to sleep and time slept by
  // picking a 3 random values < 100ms and sleeping for each value 10 times
  var sleepExp =
    Experiment.seq(
      Experiment.times('delayChoice', 3),
      Experiment.choose('delay', 100),
      Experiment.times(10),

      // NOTE: not clear here, but Experiment.after executes in REVERSE order
      // under seq since it happens as the stack unwinds on the way out
      // TODO: maybe provide an inner chaining/seq combinator to hide this detail?
      Experiment.compute(function diff(delay, runtime) {
        return 1 - delay / (runtime / 1e6);
      }),

      Experiment.timed(
        Experiment.under(function(spec, emit) {
          setTimeout(function() {
            emit(spec);
          }, spec.delay);
        })
      )

    )
    ;

  /* TODO: write a parsing layer which transforms the following into the above:
   *
   * [
   *   {$times: 3},
   *   {$choose: ['delay', 100]},
   *   {$times: 10},
   *   {$compute: function diff(delay, runtime) {
   *                return 1 - delay / (runtime / 1e6);
   *              }},
   *   {$timed: {$under: function(spec, emit) {
   *     setTimeout(function() {
   *       emit(spec);
   *     }, spec.delay);
   *   }}}
   * ]
   */

  // TODO: write something more advanced like Experiment.cliHarness which
  // allows to specify arbitrary spec properties
  Experiment.run(
    sleepExp,
    Experiment.emitSepRecords(process.stdout)
  );
}

