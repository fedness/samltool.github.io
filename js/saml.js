Samlp.prototype = {
  getSamlRequestUrl: function (opts, callback) {
    var options = xtend(opts || {}, this.options);

    var assert_and_destination = templates.assert_and_destination({
      Destination:      options.identityProviderUrl,
      AssertionConsumerServiceURL: options.callback
    });

    var model = {
      ID:               '_' + generateUniqueID(),
      IssueInstant:     generateInstant(),
      Issuer:           options.realm,
      ProtocolBinding:  options.protocolBinding,
      ForceAuthn:       options.forceAuthn,
      AssertServiceURLAndDestination: assert_and_destination
    };

    if (options.requestContext) {
      model = xtend(model, options.requestContext);
    }

    var SAMLRequest = trimXml(!options.requestTemplate ? templates.samlrequest(model) : supplant(options.requestTemplate, model));

    if (options.deflate) {
      zlib.deflateRaw(new Buffer(SAMLRequest), function(err, buffer) {
        if (err) return callback(err);

        callback(null, buildUrl(buffer));
      });
    } else {
      callback(null, buildUrl(new Buffer(SAMLRequest)));
    }

    function buildUrl(buffer) {
      var parsed = url.parse(options.identityProviderUrl, true);
      var samlRequest = options.identityProviderUrl.split('?')[0] + '?' + qs.encode( xtend(parsed.query, { SAMLRequest: buffer.toString('base64'), RelayState: options.RelayState || '' }));
      return samlRequest;
    }
  },

  decodeResponse: function(req) {
    var decoded = new Buffer(req.body['SAMLResponse'], 'base64').toString();
    return decoded;
  },

  extractAssertion: function(samlpResponse, callback) {
    if (typeof samlpResponse === 'string') {
      samlpResponse = new xmldom.DOMParser().parseFromString(samlpResponse);
    }

    var saml2Namespace = 'urn:oasis:names:tc:SAML:2.0:assertion';
    var done = function (err, assertion) {
      if (err) { return callback(err); }

      if (typeof assertion === 'string') {
        assertion = new xmldom.DOMParser().parseFromString(assertion);
      }

      // if saml assertion has a prefix but namespace is defined on parent, copy it to assertion
      if (assertion && assertion.prefix && !assertion.getAttributeNS(saml2Namespace, assertion.prefix)) {
        assertion.setAttribute('xmlns:' + assertion.prefix, assertion.lookupNamespaceURI(assertion.prefix));
      }

      callback(null, assertion);
    };

    var token = samlpResponse.getElementsByTagNameNS(saml2Namespace, 'Assertion')[0];
    if (!token) {
      // check for encrypted assertion
      var encryptedToken = samlpResponse.getElementsByTagNameNS(saml2Namespace, 'EncryptedAssertion')[0];
      if (encryptedToken) {

        var encryptedData = encryptedToken.getElementsByTagNameNS('http://www.w3.org/2001/04/xmlenc#', 'EncryptedData')[0];
        if (!encryptedData) {
          return done(new Error('EncryptedData not found.'));
        }

        if (!this.options.decryptionKey) {
          return done(new Error('Assertion is encrypted. Please set options.decryptionKey with your decryption private key.'));
        }

        return xmlenc.decrypt(encryptedData.toString(), { key: this.options.decryptionKey, autopadding: this.options.autopadding }, done);
      }
    }

    done(null, token);
  },

  validateSamlResponse: function (samlResponse, callback) {
    var self = this;

    if (typeof samlResponse === 'string') {
      samlResponse = new xmldom.DOMParser().parseFromString(samlResponse);
    }

    self.extractAssertion(samlResponse, function (err, assertion) {
      if (err) { return callback(err); }
      if (!assertion) {
        return callback(new Error('saml response does not contain an Assertion element'));
      }

      var samlResponseSignaturePath = "//*[local-name(.)='Response']/*[local-name(.)='Signature' and namespace-uri(.)='http://www.w3.org/2000/09/xmldsig#']";
      var isResponseSigned = xpath.select(samlResponseSignaturePath, samlResponse).length > 0;
      var samlAssertionSignaturePath = "//*[local-name(.)='Assertion']/*[local-name(.)='Signature' and namespace-uri(.)='http://www.w3.org/2000/09/xmldsig#']";
      var isAssertionSigned =  xpath.select(samlAssertionSignaturePath, assertion).length > 0;

      if (!isResponseSigned && !isAssertionSigned) {
        return callback(new Error('neither the response nor the assertion are signed'));
      }

      if (isResponseSigned) {
        self._saml.validateSignature(samlResponse, {
          cert: self.options.cert,
          thumbprint: self.options.thumbprint,
          signaturePath: samlResponseSignaturePath
        },
        function (err) {
          if (err) { return callback(err); }

          if (!isAssertionSigned) {
            return self._saml.parseAssertion(assertion, callback);
          }

          return self._saml.validateSamlAssertion(assertion, callback);
        });
      }
      else if (isAssertionSigned) {
        return self._saml.validateSamlAssertion(assertion, callback);
      }
    });
  }
};