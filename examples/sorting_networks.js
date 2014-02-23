var Experiment = require('../experiment.js');

// TODO: generalize to run over a range of input sizes

Experiment.run(
  Experiment.seq(

    // this actually isn't a good way to pick sorting networks for N > 3, since
    // optimal networks usually include duplicate comparisons, and ordering is
    // _crucial_ to even validity of the search; this is only here as an
    // expedient for demo
    Experiment.permute('network'),

    Experiment.permute('input'),

    Experiment.stabalize('runtime'),

    Experiment.counted('rel'),
    Experiment.counted('swap'),

    Experiment.compute(function valid(output, rel) {
      for (var i=0, n=output.length-1; i<n; i++)
        if (! rel(output[i], output[i+1]))
          return false;
      return true;
    }),

    Experiment.copy('input', 'output'),
    Experiment.timed(
      Experiment.under(function(spec, emit) {
        var A       = spec.output;
        var network = spec.network;
        for (var i=0, n=network.length; i<n; i++) {
          var j = network[i][0];
          var k = network[i][1];
          if (spec.rel(A[k], A[j]))
            spec.swap(A, j, k);
        }
        emit(spec);
      })
    )

  ),

  {
    input: [0, 1, 2],
    network: [[0, 1], [1, 2], [0, 2]],
    rel: function(a, b) {return a<b;},
    swap: function(A, i, j) {
      var tmp = A[i];
      A[i] = A[j];
      A[j] = tmp;
    }
  },

  Experiment.emitSepRecords(process.stdout)
);
